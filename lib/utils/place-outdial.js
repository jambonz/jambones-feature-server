const Emitter = require('events');
const {CallStatus} = require('./constants');
const SipError = require('drachtio-srf').SipError;
const {TaskPreconditions, CallDirection} = require('../utils/constants');
const CallInfo = require('../session/call-info');
const assert = require('assert');
const ConfirmCallSession = require('../session/confirm-call-session');
const hooks = require('./notifiers');
const moment = require('moment');
const parseUrl = require('parse-url');

class SingleDialer extends Emitter {
  constructor({logger, sbcAddress, target, opts, application, callInfo}) {
    super();
    assert(target.type);

    this.logger = logger;
    this.target = target;
    this.sbcAddress = sbcAddress;
    this.opts = opts;
    this.application = application;
    this.url = target.url;
    this.method = target.method;

    this.bindings = logger.bindings();

    this.parentCallInfo = callInfo;
/*
    this.callInfo = Object.assign({}, callInfo, {
      callSid: this._callSid,
      parentCallSid: callInfo.callSid,
      direction: CallDirection.Outbound,
      callStatus: CallStatus.Trying,
      sipStatus: 100
    });
*/
    this.callGone = false;

    this.on('callStatusChange', this._notifyCallStatusChange.bind(this));
  }

  get callSid() {
    return this._callSid;
  }
  get callStatus() {
    return this.callInfo.callStatus;
  }

  async exec(srf, ms, opts) {
    let uri, to;
    switch (this.target.type) {
      case 'phone':
        assert(this.target.number);
        uri = `sip:${this.target.number}@${this.sbcAddress}`;
        to = this.target.number;
        break;
      case 'user':
        assert(this.target.name);
        uri = `sip:${this.target.name}`;
        to = this.target.name;
        break;
      case 'sip':
        assert(this.target.sipUri);
        uri = this.target.sipUri;
        to = this.target.sipUri;
        break;
      default:
        // should have been caught by parser
        assert(false, `invalid dial type ${this.target.type}: must be phone, user, or sip`);
    }

    try {
      this.ep = await ms.createEndpoint();
      this.logger.debug(`SingleDialer:exec - created endpoint ${this.ep.uuid}`);
      let sdp;
      const connectStream = async(remoteSdp) => {
        if (remoteSdp !== sdp) {
          this.ep.modify(sdp = remoteSdp);
          return true;
        }
        return false;
      };

      Object.assign(opts, {
        proxy: `sip:${this.sbcAddress}`,
        localSdp: this.ep.local.sdp
      });
      if (this.target.auth) opts.auth = this.target.auth;
      this.dlg = await srf.createUAC(uri, opts, {
        cbRequest: (err, req) => {
          if (err) return this.logger.error(err, 'SingleDialer:exec Error creating call');

          /**
           * INVITE has been sent out
           *  (a) create a logger for this call
           *  (b) augment this.callInfo with additional call info
           */
          this.callInfo = new CallInfo({
            direction: CallDirection.Outbound,
            parentCallInfo: this.parentCallInfo,
            req
          });
          this.logger = srf.locals.parentLogger.child({
            callSid: this.callInfo.callSid,
            parentCallSid: this.parentCallInfo.callSid,
            callId: this.callInfo.callId
          });
          this.inviteInProgress = req;
          const {actionHook, notifyHook} = hooks(this.logger, this.callInfo);
          this.actionHook = actionHook;
          this.notifyHook = notifyHook;
          this.emit('callStatusChange', {callStatus: CallStatus.Trying, sipStatus: 100});
        },
        cbProvisional: (prov) => {
          const status = {sipStatus: prov.status};
          if ([180, 183].includes(prov.status) && prov.body) {
            status.callStatus = CallStatus.EarlyMedia;
            if (connectStream(prov.body)) this.emit('earlyMedia');
          }
          else status.callStatus = CallStatus.Ringing;
          this.emit('callStatusChange', status);
        }
      });
      connectStream(this.dlg.remote.sdp);
      this.dlg.callSid = this.callSid;
      this.inviteInProgress = null;
      this.emit('callStatusChange', {sipStatus: 200, callStatus: CallStatus.InProgress});
      this.logger.debug(`SingleDialer:exec call connected: ${this.callSid}`);
      const connectTime = this.dlg.connectTime = moment();

      this.dlg.on('destroy', () => {
        const duration = moment().diff(connectTime, 'seconds');
        this.logger.debug('SingleDialer:exec called party hung up');
        this.emit('callStatusChange', {callStatus: CallStatus.Completed, duration});
        this.ep.destroy();
      });

      if (this.url) this._executeApp(this.url);
      else this.emit('accept');
    } catch (err) {
      const status = {callStatus: CallStatus.Failed};
      if (err instanceof SipError) {
        status.sipStatus = err.status;
        if (err.status === 487) status.callStatus = CallStatus.NoAnswer;
        else if ([486, 600].includes(err.status)) status.callStatus = CallStatus.Busy;
        this.logger.debug(`SingleDialer:exec outdial failure ${err.status}`);
      }
      else {
        this.logger.error(err, 'SingleDialer:exec');
        status.sipStatus = 500;
      }
      this.emit('callStatusChange', status);
      if (this.ep) this.ep.destroy();
    }
  }

  /**
   * kill the call in progress or the stable dialog, whichever we have
   */
  async kill() {
    if (this.inviteInProgress) await this.inviteInProgress.cancel();
    else if (this.dlg && this.dlg.connected) {
      const duration = moment().diff(this.dlg.connectTime, 'seconds');
      this.logger.debug('SingleDialer:kill hanging up called party');
      this.emit('callStatusChange', {callStatus: CallStatus.Completed, duration});
    }
    if (this.ep) {
      this.logger.debug(`SingleDialer:kill - deleting endpoint ${this.ep.uuid}`);
      await this.ep.destroy();
    }
  }

  /**
   * Run an application on the call after answer, e.g. call screening.
   * Once the application completes in some fashion, emit an 'accepted' event
   * if the call is still up/connected, a 'decline' otherwise.
   * Note: the application to run may not include a dial or sip:decline verb
   * @param {*} url - url for application
   */
  async _executeApp(url) {
    this.logger.debug(`SingleDialer:_executeApp: executing ${url} after connect`);
    try {
      let auth;
      const app = Object.assign({}, this.application);
      if (url.startsWith('/')) {
        const savedUrl = url;
        const or = app.originalRequest;
        url = `${or.baseUrl}${url}`;
        auth = or.auth;
        this.logger.debug({originalUrl: savedUrl, normalizedUrl: url}, 'SingleDialer:_executeApp normalized url');
      }
      else {
        const u = parseUrl(url);
        const myPort = u.port ? `:${u.port}` : '';
        app.originalRequest = {
          baseUrl: `${u.protocol}://${u.resource}${myPort}`
        };
      }

      const tasks = await this.actionHook(url, this.method, auth);
      const allowedTasks = tasks.filter((task) => {
        return [
          TaskPreconditions.StableCall,
          TaskPreconditions.Endpoint
        ].includes(task.preconditions);
      });
      if (tasks.length !== allowedTasks.length) {
        throw new Error('unsupported verb in dial url');
      }

      this.logger.debug(`SingleDialer:_executeApp: executing ${tasks.length} tasks`);
      const cs = new ConfirmCallSession({logger: this.logger, application: app, dlg: this.dlg, ep: this.ep, tasks});
      await cs.exec();
      this.emit(this.dlg.connected ? 'accept' : 'decline');
    } catch (err) {
      this.logger.debug(err, 'SingleDialer:_executeApp: error');
      this.emit('decline');
      if (this.dlg.connected) this.dlg.destroy();
    }
  }

  _notifyCallStatusChange({callStatus, sipStatus}) {
    this.logger.debug(`SingleDialer:_notifyCallStatusChange: ${callStatus} ${sipStatus}`);
    this.callInfo.updateStatus(callStatus, sipStatus);
    try {
      this.notifyHook(this.application.call_status_hook);
    } catch (err) {
      this.logger.info(err, `SingleDialer:_notifyCallStatusChange error sending ${callStatus} ${sipStatus}`);
    }
  }
}

function placeOutdial({logger, srf, ms, sbcAddress, target, opts, application, callInfo}) {
  const sd = new SingleDialer({logger, sbcAddress, target, opts, application, callInfo});
  sd.exec(srf, ms, opts);
  return sd;
}

module.exports = placeOutdial;
