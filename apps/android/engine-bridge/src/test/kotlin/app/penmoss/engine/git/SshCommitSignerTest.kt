package app.penmoss.engine.git

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.security.interfaces.ECPublicKey
import java.util.concurrent.TimeUnit

/**
 * Commit signing on Android (#172, A921): a P-256 key (the Keystore's on the phone, a software
 * one here) signs each commit as `git` does with `gpg.format=ssh`, and system git and OpenSSH
 * verify it. With signing on, a key that cannot sign stops the sync: never an unsigned commit.
 */
class SshCommitSignerTest {
    @get:Rule
    val temp = TemporaryFolder()

    init {
        GitTestRepos.ready()
    }

    private val me = GitIdentity("Ryan on the Pixel", "ryan@example.invalid")

    private fun transport(remote: File, signing: () -> CommitSigning) =
        JGitTransport(
            File(temp.newFolder(), "repo.git"), GitTestRepos.url(remote), "main", "", { me }, { null },
            clock = { 1_761_700_000_000 }, signing = signing,
        )

    private fun run(dir: File, vararg command: String, input: String? = null): Pair<Int, String> {
        val process = ProcessBuilder(*command).directory(dir).redirectErrorStream(true).start()
        if (input != null) process.outputStream.use { it.write(input.toByteArray()) } else process.outputStream.close()
        val out = process.inputStream.bufferedReader().readText()
        assertTrue("$command timed out", process.waitFor(60, TimeUnit.SECONDS))
        return process.exitValue() to out
    }

    @Test
    fun aSignedCommitVerifiesWithGitAndSshKeygen() {
        val remote = GitTestRepos.bare(temp.newFolder("remote.git"))
        val key = SoftwareKey()
        val signer = SshCommitSigner(key)
        val git = transport(remote) { CommitSigning.On { signer } }
        assertNull(git.fetch())
        val first = git.commit(null, mapOf(".penmoss/notebook.json" to "{}\n".toByteArray()), "Penmoss: 0 notes [skip ci]\n")!!
        assertEquals(PushOutcome.PUSHED, git.push(first))

        val line = signer.publicKeyLine("Penmoss on Pixel 9")
        assertTrue(line, line.startsWith("ecdsa-sha2-nistp256 AAAA") && line.endsWith(" Penmoss on Pixel 9"))
        val allowed = File(temp.root, "allowed_signers").apply { writeText("ryan@example.invalid ${line.substringBeforeLast(' ')}\n") }
        // System git, as GitHub checks it: `git verify-commit` with an allowed-signers file.
        val (code, out) = run(
            remote, "git", "-c", "gpg.format=ssh", "-c", "gpg.ssh.allowedSignersFile=${allowed.absolutePath}",
            "verify-commit", "--raw", first,
        )
        assertEquals(out, 0, code)
        assertTrue(out, out.contains("Good \"git\" signature for ryan@example.invalid"))

        // OpenSSH itself, on the payload git signed (the commit without its gpgsig header).
        val raw = run(remote, "git", "cat-file", "commit", first).second
        val signature = raw.lines().dropWhile { !it.startsWith("gpgsig ") }
            .takeWhile { it.startsWith("gpgsig ") || it.startsWith(" ") }
            .joinToString("\n") { it.removePrefix("gpgsig ").removePrefix(" ") }
        val payload = raw.lines().let { lines ->
            val start = lines.indexOfFirst { it.startsWith("gpgsig ") }
            val end = (start + 1 until lines.size).first { !lines[it].startsWith(" ") }
            (lines.subList(0, start) + lines.subList(end, lines.size)).joinToString("\n")
        }
        val sigFile = File(temp.root, "commit.sig").apply { writeText(signature + "\n") }
        val (verified, said) = run(
            temp.root, "ssh-keygen", "-Y", "verify", "-f", allowed.absolutePath, "-I", "ryan@example.invalid",
            "-n", "git", "-s", sigFile.absolutePath, input = payload,
        )
        assertEquals(said, 0, verified)

        // Another key's allowed-signers line does not verify it.
        val other = SshCommitSigner(SoftwareKey()).publicKeyLine("")
        File(temp.root, "other_signers").writeText("ryan@example.invalid $other\n")
        val (refused, _) = run(
            remote, "git", "-c", "gpg.format=ssh", "-c", "gpg.ssh.allowedSignersFile=${File(temp.root, "other_signers").absolutePath}",
            "verify-commit", first,
        )
        assertTrue("another key's signers file refuses it", refused != 0)
    }

    @Test
    fun withSigningOnAKeyThatCannotSignStopsTheSyncAndNoCommitIsMade() {
        val remote = GitTestRepos.bare(temp.newFolder("remote.git"))
        val gone = transport(remote) { CommitSigning.On { throw IllegalStateException("the key is gone") } }
        assertNull(gone.fetch())
        try {
            gone.commit(null, mapOf("a.md" to "a".toByteArray()), "x")
            fail("an unsigned commit was made")
        } catch (error: GitException) {
            assertEquals(GitErrorCode.SIGNING, error.code)
            assertTrue(error.message, error.message!!.startsWith("Sync stopped: signing."))
        }
        // A key that signs badly is caught before the commit is made, too.
        val wrong = SoftwareKey()
        val liar = object : CommitSigningKey {
            override val publicKey: ECPublicKey = SoftwareKey().publicKey
            override fun sign(data: ByteArray): ByteArray = wrong.sign(data)
        }
        val bad = transport(remote) { CommitSigning.On { SshCommitSigner(liar) } }
        assertNull(bad.fetch())
        try {
            bad.commit(null, mapOf("a.md" to "a".toByteArray()), "x")
            fail("a commit with a bad signature was made")
        } catch (error: GitException) {
            assertEquals(GitErrorCode.SIGNING, error.code)
        }
        assertNull("nothing reached the remote", GitTestRepos.head(remote, "main"))
        // Off, as before: unsigned.
        val off = transport(remote) { CommitSigning.Off }
        assertNull(off.fetch())
        val plain = off.commit(null, mapOf("a.md" to "a".toByteArray()), "x")!!
        assertEquals(PushOutcome.PUSHED, off.push(plain))
        assertFalse(run(remote, "git", "cat-file", "commit", plain).second.contains("gpgsig"))
    }

    /**
     * #174 review: an Ed25519 key (`ssh-ed25519`, as `ssh-keygen` makes by default) signs as
     * well, where the phone's Keystore has Ed25519; system git and OpenSSH verify it.
     */
    @Test
    fun anEd25519KeySignsAsSshEd25519AndGitAndSshKeygenVerifyIt() {
        val remote = GitTestRepos.bare(temp.newFolder("remote.git"))
        val signer = SshCommitSigner(SoftwareEd25519Key())
        val git = transport(remote) { CommitSigning.On { signer } }
        assertNull(git.fetch())
        val first = git.commit(null, mapOf(".penmoss/notebook.json" to "{}\n".toByteArray()), "Penmoss: 0 notes [skip ci]\n")!!
        assertEquals(PushOutcome.PUSHED, git.push(first))

        val line = signer.publicKeyLine("Penmoss on Pixel 9")
        assertTrue(line, line.startsWith("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI") && line.endsWith(" Penmoss on Pixel 9"))
        val (code, out) = SignatureChecks.verifyCommit(remote, first, "ryan@example.invalid", line, temp.root)
        assertEquals(out, 0, code)
        assertTrue(out, out.contains("Good \"git\" signature for ryan@example.invalid with ED25519 key"))

        // OpenSSH reads the public key line as its own `.pub` file.
        val pub = File(temp.root, "phone.pub").apply { writeText(line + "\n") }
        val (fingerprint, said) = run(temp.root, "ssh-keygen", "-l", "-f", pub.absolutePath)
        assertEquals(said, 0, fingerprint)
        assertTrue(said, said.trim().endsWith("(ED25519)"))

        // Another Ed25519 key, or the same signature over other bytes, does not verify.
        val other = SshCommitSigner(SoftwareEd25519Key()).publicKeyLine("")
        assertTrue("another key refuses it", SignatureChecks.verifyCommit(remote, first, "ryan@example.invalid", other, temp.root).first != 0)
        val armored = signer.sign("tree 1\n".toByteArray())
        assertTrue(signer.verifies("tree 1\n".toByteArray(), armored))
        assertFalse(signer.verifies("tree 2\n".toByteArray(), armored))
        assertFalse("a P-256 key never passes for it", SshCommitSigner(SoftwareKey()).verifies("tree 1\n".toByteArray(), armored))
    }

    /** #174 review: the key store makes the kind asked for, P-256 unless Ed25519 is asked. */
    @Test
    fun theKeyStoreMakesTheKindAsked() {
        val keys = SoftwareKeyStore()
        assertEquals(CommitKeyType.P256, CommitKeyType.of(keys.create().publicKey))
        assertEquals(CommitKeyType.ED25519, CommitKeyType.of(keys.create(CommitKeyType.ED25519).publicKey))
        assertTrue(SshCommitSigner(keys.key()!!).publicKeyLine("").startsWith("ssh-ed25519 "))
    }

    @Test
    fun aSignatureOfOtherBytesDoesNotVerify() {
        val signer = SshCommitSigner(SoftwareKey())
        val armored = signer.sign("tree 1\n".toByteArray())
        assertTrue(signer.verifies("tree 1\n".toByteArray(), armored))
        assertFalse(signer.verifies("tree 2\n".toByteArray(), armored))
    }
}
