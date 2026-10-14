export class BridgeError extends Error {
  constructor(message, status = 502, code = 'bridge_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}
