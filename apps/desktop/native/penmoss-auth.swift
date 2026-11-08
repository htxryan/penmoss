// The Mac's own check before an admin change (T41, D34, A504).
//
// Asks macOS to confirm the owner is at the Mac: Touch ID, or the account's password when
// Touch ID is unavailable, locked out (after failed tries), or the lid is closed
// (LocalAuthentication's deviceOwnerAuthentication policy). Never a plain confirmation.
//
// Usage: Penmoss "<reason>"   (macOS shows: “Penmoss is trying to <reason>.”)
// The main process passes the reason from its own table, never from a page, and trusts only
// the exit code:
//   0   the owner confirmed
//   1   refused: cancelled, failed, or the prompt could not be shown
//   2   unavailable: this Mac has no Touch ID and no password to check
//   64  usage error (no reason given)
// Built with swiftc when the app is packaged (scripts/build-auth-helper.mjs) and shipped in
// Contents/Resources/auth/Penmoss, signed with the app.

import Foundation
import LocalAuthentication

let arguments = CommandLine.arguments
guard arguments.count == 2, !arguments[1].isEmpty, arguments[1].count <= 200 else {
  FileHandle.standardError.write("usage: Penmoss <reason>\n".data(using: .utf8)!)
  exit(64)
}

let context = LAContext()
var unavailable: NSError?
guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &unavailable) else {
  let reason = unavailable?.localizedDescription ?? "unavailable"
  FileHandle.standardError.write("cannot check the owner: \(reason)\n".data(using: .utf8)!)
  exit(2)
}

let done = DispatchSemaphore(value: 0)
var confirmed = false
context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: arguments[1]) { success, error in
  confirmed = success
  if let error = error {
    FileHandle.standardError.write("not confirmed: \(error.localizedDescription)\n".data(using: .utf8)!)
  }
  done.signal()
}
done.wait()
exit(confirmed ? 0 : 1)
