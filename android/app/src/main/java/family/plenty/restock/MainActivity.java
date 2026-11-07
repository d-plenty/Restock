package family.plenty.restock;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own native code (SQLite, background price checks) must be registered
        // before the web app starts.
        registerPlugin(RestockNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
