package org.simplmusik.player;

import android.media.AudioFormat;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;

import java.io.BufferedOutputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * Turning a sound into samples, to be listened to rather than played.
 *
 * <p>`identify` fingerprints a TikTok's sound for Shazam, and a fingerprint is
 * made from plain 16-bit mono samples. On a desktop the CLI asks ffmpeg for
 * those. There is no ffmpeg here, but every Android carries decoders for the
 * mp3 and AAC that TikTok serves - the same ones the player uses - and
 * {@link MediaCodec} will hand their output over as PCM. This does that and
 * nothing more: bringing the rate down to 16 kHz is left to the Python side,
 * which has numpy to do it with.
 *
 * <p>Public, for the reason {@link Playback} is: Python reaches this through
 * reflection, and reflection is shown only what is public.
 */
public final class Decoder {

    private Decoder() {}

    /**
     * Decode a stretch of an audio file to signed 16-bit mono samples.
     *
     * <p>Written raw and little-endian to {@code out}, at whatever rate the
     * file is in, which is what this answers - or 0 when the file has no audio
     * in it at all. Channels are averaged into one.
     */
    public static int pcm(String in, String out, long startMs, long lengthMs) throws IOException {
        MediaExtractor extractor = new MediaExtractor();
        MediaCodec codec = null;
        try (OutputStream os = new BufferedOutputStream(new FileOutputStream(out))) {
            extractor.setDataSource(in);
            MediaFormat format = null;
            for (int i = 0; i < extractor.getTrackCount() && format == null; i++) {
                MediaFormat f = extractor.getTrackFormat(i);
                String mime = f.getString(MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("audio/")) {
                    extractor.selectTrack(i);
                    format = f;
                }
            }
            if (format == null) return 0;

            codec = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME));
            codec.configure(format, null, null, 0);
            codec.start();

            long startUs = startMs * 1000, endUs = (startMs + lengthMs) * 1000;
            if (startUs > 0) extractor.seekTo(startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC);

            int rate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE);
            int channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
            boolean floats = false;
            long written = 0;
            boolean inputDone = false;
            int idle = 0;
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();

            while (true) {
                if (!inputDone) {
                    int ix = codec.dequeueInputBuffer(10_000);
                    if (ix >= 0) {
                        ByteBuffer buf = codec.getInputBuffer(ix);
                        int n = extractor.readSampleData(buf, 0);
                        long t = extractor.getSampleTime();
                        if (n < 0 || t > endUs) {
                            codec.queueInputBuffer(ix, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inputDone = true;
                        } else {
                            codec.queueInputBuffer(ix, 0, n, t, 0);
                            extractor.advance();
                        }
                    }
                }

                int ox = codec.dequeueOutputBuffer(info, 10_000);
                if (ox == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    // What the decoder actually produces, which can differ from
                    // what the file said - a mono AAC decoded as stereo, say.
                    MediaFormat f = codec.getOutputFormat();
                    rate = f.getInteger(MediaFormat.KEY_SAMPLE_RATE);
                    channels = f.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
                    floats = f.containsKey(MediaFormat.KEY_PCM_ENCODING)
                            && f.getInteger(MediaFormat.KEY_PCM_ENCODING) == AudioFormat.ENCODING_PCM_FLOAT;
                    continue;
                }
                if (ox < 0) {
                    // Nothing yet. With all the input handed over, a decoder
                    // that stays silent this long has nothing more to give.
                    if (inputDone && ++idle > 100) break;
                    continue;
                }
                idle = 0;

                ByteBuffer buf = codec.getOutputBuffer(ox);
                long wanted = lengthMs * rate / 1000 - written;
                if (buf != null && info.size > 0 && wanted > 0) {
                    buf.order(ByteOrder.nativeOrder());
                    int frameBytes = (floats ? 4 : 2) * channels;
                    long frames = info.size / frameBytes;
                    // A seek lands on the frame before the start, so the
                    // first buffer can begin a little early.
                    long skip = info.presentationTimeUs < startUs
                            ? Math.min(frames, (startUs - info.presentationTimeUs) * rate / 1_000_000)
                            : 0;
                    int count = (int) Math.max(0, Math.min(frames - skip, wanted));
                    byte[] pcm = new byte[count * 2];
                    for (int k = 0; k < count; k++) {
                        int base = info.offset + (int) (skip + k) * frameBytes;
                        int sum = 0;
                        for (int c = 0; c < channels; c++) {
                            sum += floats
                                    ? (int) Math.max(-32768, Math.min(32767, buf.getFloat(base + 4 * c) * 32767f))
                                    : buf.getShort(base + 2 * c);
                        }
                        int s = sum / channels;
                        pcm[2 * k] = (byte) s;
                        pcm[2 * k + 1] = (byte) (s >> 8);
                    }
                    os.write(pcm);
                    written += count;
                }
                codec.releaseOutputBuffer(ox, false);
                if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0
                        || lengthMs * rate / 1000 - written <= 0) break;
            }
            return rate;
        } finally {
            if (codec != null) {
                try {
                    codec.stop();
                } catch (IllegalStateException ignored) {
                    // never started, or already gone: release is still right
                }
                codec.release();
            }
            extractor.release();
        }
    }
}
