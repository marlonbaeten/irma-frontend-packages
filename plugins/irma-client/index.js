const ServerSession = require('./server-session');
const ServerState   = require('./server-state');
const merge         = require('deepmerge');

module.exports = class IrmaClient {

  constructor({stateMachine, options}) {
    this._stateMachine = stateMachine;
    this._options      = this._sanitizeOptions(options);
    this._session      = this._options.session ? new ServerSession(this._options.session) : false;
  }

  stateChange({newState, payload}) {
    switch(newState) {
      case 'Loading':
        return this._startNewSession();
      case 'MediumContemplation':
        return this._startWatchingServerState(payload);
      case 'Cancelled':
      case 'TimedOut':
      case 'Error':
      case 'Success':
        if (this._serverState)
          this._serverState.close();
        break;
      case 'Aborted':
        this._serverCancelSession();
        break;
    }
  }

  start() {
    this._stateMachine.transition('initialize');
  }

  _startNewSession() {
    if (this._session) {
      this._session.start()
        .then(qr => {
          if (this._stateMachine.currentState() == 'Loading') {
            this._stateMachine.transition('loaded', qr);
          } else {
            // State was changed while loading, so cancel again.
            this._serverState = new ServerState(qr.u, this._options.state);
            this._serverCancelSession();
          }
        })
        .catch(error => {
          if (this._options.debugging)
            console.error("Error starting a new session on the server:", error);

          this._handleNoSuccess('fail', error);
        })
    }
  }

  _startWatchingServerState(payload) {
    this._serverState = new ServerState(payload.u, this._options.state);

    try {
      this._serverState.observe(s => this._serverStateChange(s), e => this._serverHandleError(e));
    } catch (error) {
      if ( this._options.debugging )
        console.error("Observing server state could not be started: ", error);

      this._handleNoSuccess('fail', error);
    }
  }

  _serverCancelSession() {
    if (this._serverState) {
      this._serverState.cancel()
        .catch(error => {
          if (this._options.debugging)
            console.error("Session could not be cancelled:", error);
        });
    }
  }

  _serverHandleError(error) {
    if ( this._options.debugging )
      console.error("Error while observing server state: ", error);

    this._handleNoSuccess('fail', error);
  }

  _serverStateChange(newState) {
    if ( newState == 'CONNECTED' )
      return this._stateMachine.transition('appConnected');

    switch(newState) {
      case 'DONE':
        // What we hope will happen ;)
        return this._successStateReached();
      case 'CANCELLED':
        // This is a conscious choice by a user.
        return this._handleNoSuccess('cancel');
      case 'TIMEOUT':
        // This is a known and understood error. We can be explicit to the user.
        return this._handleNoSuccess('timeout');
      default:
        // Catch unknown errors and give generic error message. We never really
        // want to get here.
        if ( this._options.debugging )
          console.error(`Unknown state received from server: '${newState}'. Payload:`, payload);

        return this._handleNoSuccess('fail', new Error('Unknown state received from server'));
    }
  }

  _successStateReached() {
    if (this._session) {
      return this._session.result()
        .then(result => this._stateMachine.transition('succeed', result))
        .catch(error => {
          if (this._options.debugging)
            console.error("Error fetching session result from the server:", error);

          this._handleNoSuccess('fail', error);
        });
    }
    this._stateMachine.transition('succeed');
  }

  _handleNoSuccess(transition, payload) {
    if (this._options.session.start)
      return this._stateMachine.transition(transition, payload);
    this._stateMachine.finalTransition(transition, payload);
  }

  _sanitizeOptions(options) {
    const defaults = {
      session: {
        url: '',
        start: {
          url:          o => `${o.url}/session`,
          parseResponse: r => r.json()
          // And default custom settings for fetch()'s init parameter
          // https://developer.mozilla.org/en-US/docs/Web/API/WindowOrWorkerGlobalScope/fetch
        },
        mapping: {
          sessionPtr:    r => r.sessionPtr,
          sessionToken:  r => r.token
        },
        result: {
          url:           (o, {sessionToken}) => `${o.url}/session/${sessionToken}/result`,
          parseResponse: r => r.json()
          // And default custom settings for fetch()'s init parameter
          // https://developer.mozilla.org/en-US/docs/Web/API/WindowOrWorkerGlobalScope/fetch
        }
      },
      state: {
        debugging:  options.debugging,

        serverSentEvents: {
          url:        o => `${o.url}/statusevents`,
          timeout:    2000,
        },

        polling: {
          url:        o => `${o.url}/status`,
          interval:   500,
          startState: 'INITIALIZED'
        },

        cancel: {
          url:        o => o.url
        }
      }
    };

    return merge(defaults, options);
  }

}
