package app.penmoss.ui

import app.penmoss.sync.SyncStop

/*
 * "Sync stopped" on the phone (T42, A578; T40 AC12, A651): Home's status line says so and leads
 * to the notebook's Sync.
 */

private fun stoppedCount(count: Int) = if (count == 1) "1 note" else "$count notes"

/** Home's status line while stopped: short; Home makes it a link to the notebook's Sync. */
fun stoppedLine(stop: SyncStop): String = "Sync stopped: " + when (stop) {
    is SyncStop.Notes -> "${stoppedCount(stop.refused.size)} could not sync"
    is SyncStop.Storage -> "this phone’s storage is full or failing"
}
