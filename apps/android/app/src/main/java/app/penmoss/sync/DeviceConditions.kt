package app.penmoss.sync

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.PowerManager

/** What the phone allows background work now (A322). */
data class DeviceConditions(
    /** Battery saver is on. */
    val powerSave: Boolean,
    /** The network in use is metered (mobile data, a metered Wi-Fi). */
    val metered: Boolean,
    /** Data Saver is on and restricts this app in the background. */
    val dataSaver: Boolean,
) {
    companion object {
        /**
         * The phone's conditions for a run on [network], the one WorkManager gave the job (A328);
         * without one, the default network.
         */
        fun read(context: Context, network: Network? = null): DeviceConditions {
            val power = context.getSystemService(PowerManager::class.java)
            val connectivity = context.getSystemService(ConnectivityManager::class.java)
            return DeviceConditions(
                powerSave = power?.isPowerSaveMode == true,
                metered = meteredOf(connectivity, network),
                dataSaver = connectivity?.restrictBackgroundStatus == ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED,
            )
        }

        private fun meteredOf(connectivity: ConnectivityManager?, network: Network?): Boolean {
            connectivity ?: return true
            val capabilities = network?.let { runCatching { connectivity.getNetworkCapabilities(it) }.getOrNull() }
                // Unknown counts as metered: the cautious choice for someone's data plan.
                ?: return connectivity.isActiveNetworkMetered
            return !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) &&
                !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_TEMPORARILY_NOT_METERED)
        }
    }
}
