// Default address of the Glotta relay server.
//
// During development this should be the LAN address printed by the server on
// startup (e.g. "Network: http://192.168.1.36:8080"). The phone and the
// computer running the server must be on the same Wi-Fi.
//
// When you deploy the server behind a public domain or tunnel, change this to
// that URL (e.g. "https://translate.yourchurch.org"). The speaker can also
// override it on the setup screen.
export const DEFAULT_SERVER_URL = 'http://192.168.1.36:8080';
