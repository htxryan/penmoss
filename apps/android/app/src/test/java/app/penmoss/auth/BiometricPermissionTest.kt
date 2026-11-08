package app.penmoss.auth

import android.content.Context
import android.content.pm.PackageManager
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The manifest asks for USE_BIOMETRIC (T40 P2a, A421). Without it the system refuses
 * `canAuthenticate`, and every admin change fails (seen on the emulator, not in the fakes).
 */
@RunWith(AndroidJUnit4::class)
class BiometricPermissionTest {
    @Test
    fun theAppAsksForUseBiometric() {
        val context: Context = ApplicationProvider.getApplicationContext()
        val info = context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS)
        assertTrue(info.requestedPermissions.orEmpty().contains("android.permission.USE_BIOMETRIC"))
    }
}
