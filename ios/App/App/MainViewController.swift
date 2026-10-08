import UIKit
import Capacitor

/// Registriert die app-eigenen Plugins (siehe SeeYouStoragePlugin.swift).
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(SeeYouStoragePlugin())
    }
}
