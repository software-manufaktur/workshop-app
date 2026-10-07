import UIKit
import Capacitor

/// Registriert die app-eigenen Plugins (siehe ICloudBackupPlugin.swift).
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(ICloudBackupPlugin())
    }
}
