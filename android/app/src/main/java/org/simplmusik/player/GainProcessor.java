package org.simplmusik.player;

import androidx.media3.common.audio.AudioProcessor;
import androidx.media3.common.audio.BaseAudioProcessor;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * One gain, in dB, applied to everything on its way to the speaker.
 *
 * <p>This is the whole of the levelling on this platform, and it is the same
 * levelling as everywhere else: the CLI works out a gain per song - the
 * quieter of "bring the average up to the target" and "leave the loudest
 * sample below the ceiling" - and hands it over. On a desktop that number
 * goes to mpv as {@code af=volume=XdB}. Here it goes here.
 *
 * <p>It could not be the player's own volume control. That is a fader between
 * zero and one, and a quiet song needs to be made <em>louder</em> - a positive
 * gain, which a fader cannot express. Multiplying the samples can, and the
 * ceiling term is what stops it clipping, so the arithmetic is done once by
 * the same code that does it on a desktop and this end just multiplies.
 */
final class GainProcessor extends BaseAudioProcessor {

    private volatile float factor = 1f;     // read on the audio thread

    /** Set the gain. 0 dB is silence-free passthrough and costs nothing. */
    void setGainDb(double db) {
        factor = db == 0 ? 1f : (float) Math.pow(10.0, db / 20.0);
    }

    @Override
    protected AudioFormat onConfigure(AudioFormat in) throws UnhandledAudioFormatException {
        // 16-bit PCM is what the decoders here produce. Anything else is
        // refused rather than passed through wrong: silently dropping the
        // levelling would be a bug you could only hear.
        if (in.encoding != androidx.media3.common.C.ENCODING_PCM_16BIT) {
            throw new UnhandledAudioFormatException(in);
        }
        return in;
    }

    @Override
    public void queueInput(ByteBuffer in) {
        float f = factor;
        int size = in.remaining();
        if (f == 1f) {                      // nothing to do, and no copy to make
            if (size > 0) replaceOutputBuffer(size).put(in).flip();
            return;
        }
        ByteBuffer out = replaceOutputBuffer(size);
        ByteBuffer src = in.order(ByteOrder.nativeOrder());
        out.order(ByteOrder.nativeOrder());
        for (int i = in.position(); i < in.limit(); i += 2) {
            int s = Math.round(src.getShort(i) * f);
            // A gain that would take a sample past full scale is held at it.
            // The ceiling the CLI works into means this should not happen; it
            // is here because a sample that wrapped would be an audible tick
            // and this is one comparison.
            out.putShort((short) Math.max(Short.MIN_VALUE, Math.min(Short.MAX_VALUE, s)));
        }
        in.position(in.limit());
        out.flip();
    }
}
