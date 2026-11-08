package app.penmoss.capture

import android.appwidget.AppWidgetManager
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf

/**
 * The Quick Settings tile and the home-screen widget (T34, A341): each opens
 * the capture sheet, empty, in a task of its own.
 */
@RunWith(AndroidJUnit4::class)
class CaptureEntryPointsTest {
    private val context: Context = ApplicationProvider.getApplicationContext()

    private fun assertOpensTheSheet(intent: android.content.Intent?) {
        requireNotNull(intent)
        assertEquals(CaptureActivity::class.java.name, intent.component?.className)
        assertEquals(ShareIntents.ACTION_CAPTURE, intent.action)
        assertEquals(CaptureDraft(), ShareIntents.draftOf(intent, context.packageName))
    }

    @Test
    fun theTileOpensItThroughAnImmutablePendingIntent() {
        val pending = CaptureTileService.capturePendingIntent(context)
        assertTrue(shadowOf(pending).isActivityIntent)
        assertTrue(shadowOf(pending).isImmutable)
        assertOpensTheSheet(shadowOf(pending).savedIntent)
    }

    @Test
    fun theTileIsDeclaredForQuickSettings() {
        val services = context.packageManager.queryIntentServices(
            android.content.Intent("android.service.quicksettings.action.QS_TILE").setPackage(context.packageName),
            0,
        )
        val tile = services.single { it.serviceInfo.name == CaptureTileService::class.java.name }
        assertEquals("android.permission.BIND_QUICK_SETTINGS_TILE", tile.serviceInfo.permission)
    }

    @Test
    fun theWidgetsButtonOpensTheSheet() {
        val manager = shadowOf(AppWidgetManager.getInstance(context))
        val id = manager.createWidget(CaptureWidget::class.java, R.layout.widget_capture)
        manager.getViewFor(id).findViewById<android.view.View>(R.id.widget_capture).performClick()
        assertOpensTheSheet(shadowOf(context as android.app.Application).nextStartedActivity)
    }

    @Test
    fun theWidgetNeverAsksToBeUpdated() {
        val info = context.packageManager.getReceiverInfo(
            android.content.ComponentName(context, CaptureWidget::class.java),
            android.content.pm.PackageManager.GET_META_DATA,
        )
        assertEquals(R.xml.capture_widget, info.metaData.getInt("android.appwidget.provider"))
        val xml = context.resources.getXml(R.xml.capture_widget)
        while (xml.eventType != org.xmlpull.v1.XmlPullParser.START_TAG) xml.next()
        assertEquals("0", xml.getAttributeValue("http://schemas.android.com/apk/res/android", "updatePeriodMillis"))
    }
}
