package app.penmoss.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.penmoss.AppGraph
import app.penmoss.ui.settings.StorageSection
import app.penmoss.ui.settings.StorageUse
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Sync and storage's storage (T40 P8, ED12, ED13), from the phone's own files and setting. */
@Composable
internal fun StorageRoute(graph: AppGraph) {
    val setting by graph.webPictures.settings.setting.collectAsStateWithLifecycle()
    var use by remember { mutableStateOf<StorageUse?>(null) }
    var counts by remember { mutableIntStateOf(0) }
    LaunchedEffect(counts) {
        use = withContext(Dispatchers.IO) { StorageUse(graph.attachments.bytesUsed(), graph.webPictures.pictures.bytesUsed()) }
    }
    val scope = rememberCoroutineScope()
    StorageSection(
        use,
        setting,
        onWebPictures = graph.webPictures.settings::set,
        onClearWebPictures = {
            scope.launch {
                withContext(Dispatchers.IO) { graph.webPictures.pictures.clear() }
                counts++
            }
        },
    )
}
