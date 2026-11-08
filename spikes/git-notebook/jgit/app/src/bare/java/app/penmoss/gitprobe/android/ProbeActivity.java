package app.penmoss.gitprobe.android;

import android.app.Activity;
import android.os.Bundle;
import android.widget.TextView;

/** The baseline: the same app without JGit, so the jgit flavor's APK minus this one is JGit's cost. */
public final class ProbeActivity extends Activity {
  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    TextView text = new TextView(this);
    text.setText("Baseline build without JGit");
    setContentView(text);
  }
}
