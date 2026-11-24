package app.penmoss.ui.home

import app.penmoss.sync.SyncStop
import app.penmoss.ui.common.noteCount

/*
 * "Sync stopped" on the phone (T42, A578; T40 AC12, A651): Home's status line says so and leads
 * to the notebook's Sync.
 */

/** Home's status line while stopped: short; Home makes it a link to the notebook's Sync. */
fun stoppedLine(stop: SyncStop): String = "Sync stopped: " + when (stop) {
    is SyncStop.Notes -> "${noteCount(stop.refused.size)} could not sync"
    is SyncStop.Storage -> "this phone’s storage is full or failing"
}
