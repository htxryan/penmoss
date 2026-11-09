package app.penmoss.proof

import android.os.ParcelFileDescriptor
import androidx.test.platform.app.InstrumentationRegistry

/**
 * The software factory's Android proof screenshot (A1255), taken from inside the test while the
 * change is on screen. `scripts/proof.sh` used to take it after the instrumentation ended, when
 * the app had closed, so PEN-70's proof showed the launcher. A proof spec calls [take] at its
 * last assertion; proof.sh pulls the file and uses it as the PR's screenshot, falling back to a
 * screenshot after the test (and saying so) when a spec took none. Outside a proof it only
 * writes a file on the device.
 */
object ProofShot {
    /** Where proof.sh looks for it; it removes the file before each spec. */
    const val PATH = "/sdcard/penmoss-proof.png"

    /** Screenshots the device now, as `adb shell screencap` would; returns once the file is written. */
    fun take() {
        val ui = InstrumentationRegistry.getInstrumentation().uiAutomation
        // Read to the end: the command has finished, and the file is whole, when its output closes.
        ParcelFileDescriptor.AutoCloseInputStream(ui.executeShellCommand("screencap -p $PATH")).use { it.readBytes() }
    }
}
