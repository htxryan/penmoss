package app.penmoss.analytics

import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.ui.common.PenmossTheme
import app.penmoss.ui.settings.PrivacyActions
import app.penmoss.ui.settings.PrivacyScreen
import app.penmoss.ui.settings.PrivacyUi
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Opening a Settings page is recorded on the phone as on the Mac (PEN-137, Ryan's review of
 * AC40 and AC49): Privacy records itself as the screen `settings.privacy` when it shows, once
 * even when the NavController's listener has recorded it already.
 */
@RunWith(AndroidJUnit4::class)
class PrivacyScreenEventsTest {
    @get:Rule
    val compose = createComposeRule()

    private val phone = AnalyticsHarness()

    @After
    fun close() {
        Analytics.install(null)
        phone.close()
    }

    @Test
    fun privacyRecordsItselfAsAScreenOnce() = runBlocking {
        Analytics.install(phone.service)
        // The NavController's listener got there first.
        Analytics.screen(ScreenKinds.of("settings/privacy"))
        compose.setContent { PenmossTheme { PrivacyScreen(PrivacyUi(install = "0".repeat(32)), PrivacyActions()) } }
        compose.waitForIdle()
        phone.service.flush()
        val screens = phone.store.page(null, null, 100).filter { it.kind == "screen" }
        assertEquals(listOf("settings.privacy"), screens.map { it.name })
    }

    @Test
    fun privacyShownWithoutTheNavControllerIsRecorded() = runBlocking {
        Analytics.install(phone.service)
        compose.setContent { PenmossTheme { PrivacyScreen(PrivacyUi(install = "0".repeat(32)), PrivacyActions()) } }
        compose.waitForIdle()
        phone.service.flush()
        val screens = phone.store.page(null, null, 100).filter { it.kind == "screen" }
        assertEquals(listOf("settings.privacy"), screens.map { it.name })
    }
}
