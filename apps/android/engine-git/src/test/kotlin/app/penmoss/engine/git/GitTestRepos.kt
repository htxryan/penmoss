package app.penmoss.engine.git

import org.eclipse.jgit.api.Git
import org.eclipse.jgit.lib.Constants
import org.eclipse.jgit.lib.PersonIdent
import org.eclipse.jgit.revwalk.RevWalk
import org.eclipse.jgit.transport.RefSpec
import org.eclipse.jgit.treewalk.TreeWalk
import java.io.File

/** Local bare repositories for the JGit tests (T50 G7): a `file://` remote and a colleague's clone. */
object GitTestRepos {
    init {
        JGitSetup.install(File(System.getProperty("java.io.tmpdir"), "penmoss-jgit-config"))
    }

    /** Installs JGit's setup (the object's init); call before any repository is made. */
    fun ready() = Unit

    fun bare(dir: File): File {
        Git.init().setBare(true).setDirectory(dir).setInitialBranch("main").call().close()
        return dir
    }

    fun url(dir: File): String = "file://" + dir.absolutePath

    /** A colleague's full clone: commits [files] (path → text, null removes) and pushes. */
    fun colleaguePush(remote: File, branch: String, files: Map<String, String?>, message: String = "Colleague"): String {
        val work = File(remote.parentFile, "colleague-${System.nanoTime()}")
        val git = try {
            Git.cloneRepository().setURI(url(remote)).setDirectory(work).setBranch(branch).call()
        } catch (error: Exception) {
            Git.init().setDirectory(work).setInitialBranch(branch).call().also {
                it.repository.config.setString("remote", "origin", "url", url(remote))
                it.repository.config.save()
            }
        }
        git.use {
            for ((path, text) in files) {
                val file = File(work, path)
                if (text == null) {
                    file.delete()
                    it.rm().addFilepattern(path).call()
                } else {
                    file.parentFile.mkdirs()
                    file.writeText(text)
                    it.add().addFilepattern(path).call()
                }
            }
            val who = PersonIdent("Colleague", "colleague@example.invalid")
            val commit = it.commit().setMessage(message).setAuthor(who).setCommitter(who).call()
            it.push().setRemote(url(remote)).setRefSpecs(RefSpec("HEAD:refs/heads/$branch")).call()
            work.deleteRecursively()
            return commit.name
        }
    }

    /** The file at the branch's head of a bare repository, or null. */
    fun fileAt(remote: File, branch: String, path: String): String? =
        Git.open(remote).use { git ->
            val head = git.repository.resolve("refs/heads/$branch") ?: return null
            RevWalk(git.repository).use { walk ->
                val tree = walk.parseCommit(head).tree
                TreeWalk.forPath(git.repository, path, tree)?.use { git.repository.open(it.getObjectId(0)).bytes.toString(Charsets.UTF_8) }
            }
        }

    fun head(remote: File, branch: String): String? = Git.open(remote).use { it.repository.resolve("refs/heads/$branch")?.name }

    /** Every path at the branch's head. */
    fun paths(remote: File, branch: String): List<String> = Git.open(remote).use { git ->
        val head = git.repository.resolve("refs/heads/$branch") ?: return emptyList()
        RevWalk(git.repository).use { walk ->
            TreeWalk(git.repository).use { tree ->
                tree.addTree(walk.parseCommit(head).tree)
                tree.isRecursive = true
                buildList { while (tree.next()) add(tree.pathString) }
            }
        }
    }

    /** The commits on the branch, newest first: their parents' counts (no merge has two). */
    fun parentCounts(remote: File, branch: String): List<Int> = Git.open(remote).use { git ->
        val head = git.repository.resolve("refs/heads/$branch") ?: return emptyList()
        git.log().add(head).call().map { it.parentCount }
    }

    fun message(remote: File, sha: String): String = Git.open(remote).use { git ->
        RevWalk(git.repository).use { it.parseCommit(git.repository.resolve(sha)).fullMessage }
    }

    fun author(remote: File, sha: String): PersonIdent = Git.open(remote).use { git ->
        RevWalk(git.repository).use { it.parseCommit(git.repository.resolve(sha)).authorIdent }
    }

    val EMPTY_TREE: String = Constants.EMPTY_TREE_ID.name
}
