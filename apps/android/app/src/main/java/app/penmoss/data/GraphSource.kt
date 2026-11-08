package app.penmoss.data

/**
 * What the graph is drawn from, as Room holds it (T40 P7, LK7, LK8; A478): the live notes
 * (newest first), which links to which (`note_links`, LK5), and the folders with the top
 * level's order, for each note's colour. Nothing is read from the server: the graph works
 * offline and costs the Worker nothing, as on the web (D20).
 */
data class GraphSource(
    val notes: List<DirectoryRow>,
    val links: List<NoteLinkEntity>,
    val folders: List<FolderEntity>,
    val rootSortMode: String,
)
