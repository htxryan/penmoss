package app.penmoss.capture

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

/**
 * The Quick Settings tile (T34, A341): one tap opens the capture sheet with the
 * keyboard up, over whatever is on screen, and collapses the shade. Nothing
 * here waits on the network or the editor, so a capture is typed and saved in
 * a few seconds.
 */
class CaptureTileService : TileService() {
    override fun onStartListening() {
        super.onStartListening()
        qsTile?.apply {
            state = Tile.STATE_INACTIVE
            label = "Capture"
            updateTile()
        }
    }

    override fun onClick() {
        super.onClick()
        // On the lock screen, the sheet opens once the phone is unlocked, rather than behind
        // the keyguard where the tap seems to do nothing (A349).
        if (isLocked) unlockAndRun(::open) else open()
    }

    // Android 17 and later only (A835): the immutable PendingIntent form, the only one since 14.
    private fun open() = startActivityAndCollapse(capturePendingIntent(this, captureIntent(this)))

    companion object {
        /** The capture sheet, as the tile and the widget open it: empty, in a task of its own. */
        fun captureIntent(context: Context): Intent =
            Intent(context, CaptureActivity::class.java)
                .setAction(ShareIntents.ACTION_CAPTURE)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)

        fun capturePendingIntent(context: Context, intent: Intent = captureIntent(context)): PendingIntent =
            PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
}
