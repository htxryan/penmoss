// Sets the main display of the test VM to a mode of at least WIDTH x HEIGHT points (docs/ci.md §8),
// run by desktop-test.sh inside the VM as its logged-in user:
//
//   swift scripts/vm/screen-size.swift 1920 1200
//
// `tart set --display` gives the VM's display the size, but macOS in the VM keeps the mode it
// chose before (the base image's 1024 x 768), and shrinks windows to fit it.
import CoreGraphics
import Foundation

let args = CommandLine.arguments.dropFirst().compactMap { Int($0) }
guard args.count == 2 else {
  FileHandle.standardError.write("usage: screen-size.swift WIDTH HEIGHT\n".data(using: .utf8)!)
  exit(2)
}
let (width, height) = (args[0], args[1])
let display = CGMainDisplayID()
let options = [kCGDisplayShowDuplicateLowResolutionModes: true] as CFDictionary
let modes = (CGDisplayCopyAllDisplayModes(display, options) as? [CGDisplayMode]) ?? []
// The smallest mode that is big enough, sharpest first.
let fits = modes.filter { $0.width >= width && $0.height >= height && $0.isUsableForDesktopGUI() }
  .sorted { ($0.width * $0.height, -$0.pixelWidth) < ($1.width * $1.height, -$1.pixelWidth) }
let current = CGDisplayCopyDisplayMode(display)
if let now = current, now.width >= width, now.height >= height {
  print("[vm] screen \(now.width) x \(now.height)")
  exit(0)
}
guard let mode = fits.first else {
  let sizes = Set(modes.map { "\($0.width)x\($0.height)" }).sorted().joined(separator: " ")
  FileHandle.standardError.write("[vm] no \(width) x \(height) screen mode; has \(sizes)\n".data(using: .utf8)!)
  exit(1)
}
var config: CGDisplayConfigRef?
guard CGBeginDisplayConfiguration(&config) == .success,
  CGConfigureDisplayWithDisplayMode(config, display, mode, nil) == .success,
  CGCompleteDisplayConfiguration(config, .permanently) == .success
else {
  FileHandle.standardError.write("[vm] could not set the screen to \(mode.width) x \(mode.height)\n".data(using: .utf8)!)
  exit(1)
}
print("[vm] screen \(mode.width) x \(mode.height)")
