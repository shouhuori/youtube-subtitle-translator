// Retain the extracted content scripts' internal message contract.
(function (scope) {
  scope.LINGREAD_MESSAGES = Object.freeze({ MSG: Object.freeze({
    HTTP_API_REQUEST: 'http:apiRequest',
    AUTH_START_RELAY: 'auth:startRelay',
    AUTH_RELAY_COMPLETE: 'auth:relayComplete',
    NAV_OPEN_HISTORY: 'nav:openHistory',
  }) });
})(globalThis);
