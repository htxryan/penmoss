package app.penmoss.ui.settings

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.penmoss.DeviceGraph
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** What this phone's storage holds now (PEN-146): every notebook's files, and the web pictures kept. */
internal suspend fun storageUse(device: DeviceGraph): StorageUse = withContext(Dispatchers.IO) {
    val hub = device.gitIfAny
    val files = hub?.list?.value.orEmpty().sumOf { view -> runCatching { hub!!.graph(view.localId).attachments.bytesUsed() }.getOrDefault(0L) }
    StorageUse(files, device.webPictures.pictures.bytesUsed(), device.webPictures.pictures.count())
}

/** Settings → Storage (T40 P8, ED12, ED13; PEN-146), from the phone's own files and setting. */
@Composable
internal fun StorageRoute(device: DeviceGraph, onBack: () -> Unit) {
    val setting by device.webPictures.settings.setting.collectAsStateWithLifecycle()
    var use by remember { mutableStateOf<StorageUse?>(null) }
    var counts by remember { mutableIntStateOf(0) }
    LaunchedEffect(counts) { use = storageUse(device) }
    val scope = rememberCoroutineScope()
    StorageScreen(
        use,
        setting,
        onWebPictures = device.webPictures.settings::set,
        onClearWebPictures = {
            scope.launch {
                withContext(Dispatchers.IO) { device.webPictures.pictures.clear() }
                counts++
            }
        },
        onBack = onBack,
    )
}
