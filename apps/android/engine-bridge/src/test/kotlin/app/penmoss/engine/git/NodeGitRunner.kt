package app.penmoss.engine.git

import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.EOFException
import java.io.File
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * The git engine page and the CLI under Node, for the cross-engine tests (T50 G7, A878): the
 * bundle `task android:editor` builds (`apps/android/build/git-runner/git-runner.mjs`) from the
 * page's own sources and the CLI's. A test fails, never skips, when it is missing.
 */
object NodeGitRunner {
    val script: File by lazy {
        val path = System.getProperty("penmoss.gitRunner") ?: error("penmoss.gitRunner is not set")
        File(path).also { check(it.isFile) { "The git runner is missing at $it: run `task android:editor` first." } }
    }

    private fun node(vararg args: String): ProcessBuilder =
        ProcessBuilder(listOf("node", script.absolutePath) + args).also { it.environment()["GIT_TERMINAL_PROMPT"] = "0" }

    /** One notebook's engine page, its store in files under [dir]. */
    fun page(dir: File): NodePort = NodePort(node("page", dir.absolutePath).start())

    /** The commit check page. */
    fun guard(): NodePort = NodePort(node("guard").start())

    data class Cli(val code: Int, val stdout: String, val stderr: String)

    /** `penmoss <args>` with its home in [home] (the CLI's own commands, system git). */
    fun cli(home: File, vararg args: String): Cli {
        val process = node("cli", home.absolutePath, *args).redirectInput(ProcessBuilder.Redirect.PIPE).start()
        process.outputStream.close()
        val err = ByteArrayOutputStream()
        val drain = thread { process.errorStream.copyTo(err) }
        val out = process.inputStream.readBytes().toString(Charsets.UTF_8)
        check(process.waitFor(120, TimeUnit.SECONDS)) { "penmoss ${args.joinToString(" ")} did not end" }
        drain.join()
        return Cli(process.exitValue(), out, err.toString(Charsets.UTF_8))
    }

    /** A note as the phone's editor makes one: the base64 update Room keeps (opaque here). */
    fun note(id: String, title: String, markdown: String): String = run("note", id, title, markdown)

    /** An edit of the note's title on top of [updates]: the pending update the editor would store. */
    fun retitle(id: String, title: String, updates: List<String>): String = run("retitle", id, title, *updates.toTypedArray())

    private fun run(vararg args: String): String {
        val process = node(*args).start()
        process.outputStream.close()
        val out = process.inputStream.readBytes().toString(Charsets.UTF_8).trim()
        check(process.waitFor(60, TimeUnit.SECONDS) && process.exitValue() == 0) { "git-runner ${args.first()} failed: ${process.errorStream.readBytes().toString(Charsets.UTF_8)}" }
        return out
    }
}

/** A Node page's frames over its stdio: each a big-endian u32 length and the frame's bytes. */
class NodePort(private val process: Process) : FramePort {
    private val output = DataOutputStream(process.outputStream.buffered())
    private val errors = StringBuffer()
    @Volatile
    private var listener: ((ByteArray) -> Unit)? = null
    private val early = java.util.concurrent.LinkedBlockingQueue<ByteArray>()

    init {
        thread(isDaemon = true, name = "node-page-out") {
            val input = DataInputStream(process.inputStream.buffered())
            try {
                while (true) {
                    val length = input.readInt()
                    val frame = ByteArray(length)
                    input.readFully(frame)
                    val current = listener
                    if (current != null) current(frame) else early.add(frame)
                }
            } catch (end: EOFException) {
                // The process ended.
            } catch (error: java.io.IOException) {
                // Killed.
            }
        }
        thread(isDaemon = true, name = "node-page-err") {
            process.errorStream.bufferedReader().forEachLine { errors.append(it).append('\n') }
        }
    }

    val stderr: String get() = errors.toString()

    override fun send(frame: ByteArray) {
        synchronized(output) {
            output.writeInt(frame.size)
            output.write(frame)
            output.flush()
        }
    }

    override fun listen(listener: (ByteArray) -> Unit) {
        this.listener = listener
        while (true) listener(early.poll() ?: break)
    }

    /** As Android kills the app's process: no goodbye, nothing flushed. */
    fun kill() {
        process.destroyForcibly()
        process.waitFor(10, TimeUnit.SECONDS)
    }

    override fun close() {
        runCatching { process.outputStream.close() }
        if (!process.waitFor(10, TimeUnit.SECONDS)) process.destroyForcibly()
    }
}
