package app.penmoss.proof

import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.util.Log
import androidx.test.platform.app.InstrumentationRegistry

/**
 * The software factory's Android proof screenshot (A1255), taken from inside the test while the
 * change is on screen. `scripts/proof.sh` used to take it after the instrumentation ended, when
 * the app had closed, so PEN-70's proof showed the launcher. A proof spec calls [take] at its
 * last assertion; proof.sh pulls the file and uses it as the PR's screenshot, falling back to a
 * screenshot after the test (and saying so) when a spec took none. Outside a proof it only
 * writes a file on the device. It logs its moment, so proof.sh can end the video there rather
 * than on the launcher after the test closes the app.
 */
object ProofShot {
    /** Where proof.sh looks for it; it removes the file before each spec. */
    const val PATH = "/sdcard/penmoss-proof.png"

    /** Screenshots the device now, as `adb shell screencap` would; returns once the file is written. */
    fun take() {
        val ui = InstrumentationRegistry.getInstrumentation().uiAutomation
        // Read to the end: the command has finished, and the file is whole, when its output closes.
        ParcelFileDescriptor.AutoCloseInputStream(ui.executeShellCommand("screencap -p $PATH")).use { it.readBytes() }
        // proof.sh ends the video here (PEN-91), against /proc/uptime, the same clock.
        Log.i(TAG, "shot at ${SystemClock.elapsedRealtime()}")
    }

    private const val TAG = "PenmossProof"
}
