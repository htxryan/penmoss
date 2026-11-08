package app.penmoss.capture

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.widget.RemoteViews
import app.penmoss.R

/**
 * The home-screen widget (T34, A341): a Capture button that opens the capture
 * sheet, as the tile does. It shows nothing from the notes, so it never needs
 * updating and never wakes the phone.
 */
class CaptureWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        for (id in ids) manager.updateAppWidget(id, views(context))
    }

    companion object {
        fun views(context: Context): RemoteViews =
            RemoteViews(context.packageName, R.layout.widget_capture).apply {
                setOnClickPendingIntent(R.id.widget_capture, CaptureTileService.capturePendingIntent(context))
            }
    }
}
