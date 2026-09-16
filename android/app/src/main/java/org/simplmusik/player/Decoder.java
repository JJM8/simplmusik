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
 * <p>Two things want samples rather than sound. `identify` fingerprints a
 * TikTok's sound for Shazam, from plain 16-bit mono samples; and levelling
 * measures a song's mean square and peak, to work out its gain - in the
 * background, as a song arrives, and never while anyone waits to hear it. On a desktop
 * the CLI asks ffmpeg for both. There is no ffmpeg here, but every Android
 * carries decoders for what we play - the same ones the player uses - and
 * {@link MediaCodec} will hand their output over as PCM. This does that and
 * nothing more: what the samples become is left to the Python side.
 *
 * <p>Public, for the reason {@link Playback} is: Python reaches this through
 * reflection, and reflection is shown only what is public.
 */
public final class Decoder {

    private Decoder() {}

    /** Handed each decoded buffer; answers false once it has had enough. */
    private interface Sink {
        boolean take(ByteBuffer buf, int offset, long frames, int channels,
                     boolean floats, int rate, long ptsUs);
    }

    /**
     * Decode a stretch of an audio file to signed 16-bit mono samples.
     *
     * <p>Written raw and little-endian to {@code out}, at whatever rate the
     * file is in, which is what this answers - or 0 when the file has no audio
     * in it at all. Channels are averaged into one.
     */
    public static int pcm(String in, String out, long startMs, long lengthMs) throws IOException {
        long startUs = startMs * 1000;
        long[] written = {0};
        try (OutputStream os = new BufferedOutputStream(new FileOutputStream(out))) {
            return decode(in, startUs, (startMs + lengthMs) * 1000,
                    (buf, offset, frames, channels, floats, rate, ptsUs) -> {
                long wanted = lengthMs * rate / 1000 - written[0];
                if (wanted <= 0) return false;
                int frameBytes = (floats ? 4 : 2) * channels;
                // A seek lands on the frame before the start, so the
                // first buffer can begin a little early.
                long skip = ptsUs < startUs
                        ? Math.min(frames, (startUs - ptsUs) * rate / 1_000_000)
                        : 0;
                int count = (int) Math.max(0, Math.min(frames - skip, wanted));
                byte[] pcm = new byte[count * 2];
                for (int k = 0; k < count; k++) {
                    int base = offset + (int) (skip + k) * frameBytes;
                    int sum = 0;
                    for (int c = 0; c < channels; c++) {
                        sum += sample(buf, base, c, floats);
                    }
                    int s = sum / channels;
                    pcm[2 * k] = (byte) s;
                    pcm[2 * k + 1] = (byte) (s >> 8);
                }
                try {
                    os.write(pcm);
                } catch (IOException e) {
                    return false;
                }
                written[0] += count;
                return lengthMs * rate / 1000 - written[0] > 0;
            });
        }
    }

    /**
     * The rate the mean square is taken at. Measured across a whole library,
     * every 12th frame of a 48 kHz song came within 0.015 dB of every frame -
     * a gain is rounded to 0.1 dB, so no song's gain changed.
     */
    private static final int MEAN_RATE = 4000;

    /**
     * A whole song's mean square and its peak, both in dBFS - what ffmpeg's
     * volumedetect reports as mean_volume and max_volume. The mean is taken
     * over every channel of one frame in each MEAN_RATE's worth; the peak over
     * every sample there is, because one missed sample is a peak missed. Null
     * when the file has no audio in it, or none that decoded.
     */
    public static double[] levels(String in) throws IOException {
        double[] sumSq = {0};
        long[] count = {0};
        long[] frame = {0};             // across buffers, so the stride is even
        int[] peak = {0};
        int rate = decode(in, 0, Long.MAX_VALUE,
                (buf, offset, frames, channels, floats, r, ptsUs) -> {
            int frameBytes = (floats ? 4 : 2) * channels;
            int stride = Math.max(1, r / MEAN_RATE);
            for (long k = 0; k < frames; k++, frame[0]++) {
                int base = offset + (int) k * frameBytes;
                boolean counted = frame[0] % stride == 0;
                for (int c = 0; c < channels; c++) {
                    int s = sample(buf, base, c, floats);
                    int a = Math.abs(s);
                    if (a > peak[0]) peak[0] = a;
                    if (counted) {
                        sumSq[0] += (double) s * s;
                        count[0]++;
                    }
                }
            }
            return true;
        });
        if (rate == 0 || count[0] == 0) return null;
        double full = 32768.0 * 32768.0;
        // Pure silence has no level to speak of; volumedetect calls it -91 dB.
        double mean = sumSq[0] == 0 ? -91.0 : 10 * Math.log10(sumSq[0] / count[0] / full);
        double max = peak[0] == 0 ? -91.0 : 10 * Math.log10((double) peak[0] * peak[0] / full);
        return new double[]{mean, max};
    }

    private static int sample(ByteBuffer buf, int base, int channel, boolean floats) {
        return floats
                ? (int) Math.max(-32768, Math.min(32767, buf.getFloat(base + 4 * channel) * 32767f))
                : buf.getShort(base + 2 * channel);
    }

    /**
     * Run the file's first audio track through its decoder from
     * {@code startUs} until {@code endUs}, the end of the file, or the sink
     * saying it has had enough. Answers the rate the samples came out at, or
     * 0 when there is no audio track.
     */
    private static int decode(String in, long startUs, long endUs, Sink sink) throws IOException {
        MediaExtractor extractor = new MediaExtractor();
        MediaCodec codec = null;
        try {
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

            if (startUs > 0) extractor.seekTo(startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC);

            int rate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE);
            int channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
            boolean floats = false;
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
                boolean more = true;
                if (buf != null && info.size > 0) {
                    buf.order(ByteOrder.nativeOrder());
                    long frames = info.size / ((floats ? 4 : 2) * channels);
                    more = sink.take(buf, info.offset, frames, channels, floats, rate,
                            info.presentationTimeUs);
                }
                codec.releaseOutputBuffer(ox, false);
                if (!more || (info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) break;
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
