package app.penmoss.sync

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.PowerManager
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.OnlineAgain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowNetwork
import org.robolectric.shadows.ShadowNetworkCapabilities

/**
 * What the phone allows background work now (A322), which the git notebooks' runs read (A881),
 * and the network coming back in front (A331). Kept from BackgroundSyncTest when the personal
 * notes' background sync went with the server (T59).
 */
@RunWith(AndroidJUnit4::class)
class DeviceConditionsTest {
    private val context: Context = ApplicationProvider.getApplicationContext()

    @Test
    fun readsBatterySaverAndDataSaverFromTheSystem() {
        val power = context.getSystemService(PowerManager::class.java)
        val connectivity = context.getSystemService(ConnectivityManager::class.java)
        assertFalse(DeviceConditions.read(context).powerSave)
        shadowOf(power).setIsPowerSaveMode(true)
        assertTrue(DeviceConditions.read(context).powerSave)

        shadowOf(connectivity).setRestrictBackgroundStatus(ConnectivityManager.RESTRICT_BACKGROUND_STATUS_DISABLED)
        assertFalse(DeviceConditions.read(context).dataSaver)
        // Data Saver on, but this app allowed unrestricted data: not restricted.
        shadowOf(connectivity).setRestrictBackgroundStatus(ConnectivityManager.RESTRICT_BACKGROUND_STATUS_WHITELISTED)
        assertFalse(DeviceConditions.read(context).dataSaver)
        shadowOf(connectivity).setRestrictBackgroundStatus(ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED)
        assertTrue(DeviceConditions.read(context).dataSaver)
    }

    @Test
    fun meteredIsReadFromTheNetworkTheRunWasGiven() {
        val connectivity = context.getSystemService(ConnectivityManager::class.java)
        val wifiNetwork = ShadowNetwork.newInstance(41)
        val cellNetwork = ShadowNetwork.newInstance(42)
        val unmetered = ShadowNetworkCapabilities.newInstance()
        shadowOf(unmetered).addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
        shadowOf(connectivity).setNetworkCapabilities(wifiNetwork, unmetered)
        shadowOf(connectivity).setNetworkCapabilities(cellNetwork, ShadowNetworkCapabilities.newInstance())
        // Whatever the default network is when the run starts (A328).
        assertFalse(DeviceConditions.read(context, wifiNetwork).metered)
        assertTrue(DeviceConditions.read(context, cellNetwork).metered)
        // A 5G plan the carrier does not meter for now counts as unmetered.
        val unmeteredFor = ShadowNetworkCapabilities.newInstance()
        shadowOf(unmeteredFor).addCapability(NetworkCapabilities.NET_CAPABILITY_TEMPORARILY_NOT_METERED)
        shadowOf(connectivity).setNetworkCapabilities(cellNetwork, unmeteredFor)
        assertFalse(DeviceConditions.read(context, cellNetwork).metered)
    }

    @Test
    fun aNetworkComingBackInFrontAsksForOnePassOnceItReachesTheInternet() {
        var asked = 0
        val online = OnlineAgain { asked++ }
        val home = ShadowNetwork.newInstance(1)
        val cell = ShadowNetwork.newInstance(2)
        val validated = ShadowNetworkCapabilities.newInstance()
        shadowOf(validated).addCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        val connecting = ShadowNetworkCapabilities.newInstance()
        // The network already up when the app came to the front: coming to the front synced (A331).
        online.registered(home, validated = true)
        online.onAvailable(home)
        online.onCapabilitiesChanged(home, validated)
        assertEquals(0, asked)
        // It goes, and another comes: a pass once the system has validated it, and only one.
        online.onLost(home)
        online.onAvailable(cell)
        online.onCapabilitiesChanged(cell, connecting)
        assertEquals(0, asked)
        online.onCapabilitiesChanged(cell, validated)
        online.onCapabilitiesChanged(cell, validated)
        assertEquals(1, asked)
        // In front with no network: the first one that comes is news.
        val offline = OnlineAgain { asked++ }
        offline.registered(null, validated = false)
        offline.onCapabilitiesChanged(home, validated)
        assertEquals(2, asked)
    }
}
