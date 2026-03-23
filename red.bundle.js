#!/usr/bin/env node
// @bun
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __require = import.meta.require;

// packages/node_modules/node-red/lib/red.js
var require_red = __commonJS((exports, module) => {
  /*!
   * Copyright JS Foundation and other contributors, http://js.foundation
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   * http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   **/
  var fs = __require("fs");
  var path = __require("path");
  var runtime = __require("@node-red/runtime");
  var redUtil = __require("@node-red/util");
  var api = __require("@node-red/editor-api");
  var server = null;
  var apiEnabled = false;
  var dns = __require("dns");
  dns.setDefaultResultOrder("ipv4first");
  function checkVersion(userSettings) {
    var semver = __require("semver");
    if (!semver.satisfies(process.version, ">=18.0.0")) {
      userSettings.UNSUPPORTED_VERSION = process.version;
    }
  }
  module.exports = {
    init: function(httpServer, userSettings) {
      if (!userSettings) {
        userSettings = httpServer;
        httpServer = null;
      }
      if (!userSettings.SKIP_BUILD_CHECK) {
        checkVersion(userSettings);
      }
      if (!userSettings.hasOwnProperty("coreNodesDir")) {
        userSettings.coreNodesDir = path.dirname(__require.resolve("@node-red/nodes"));
      }
      redUtil.init(userSettings);
      if (userSettings.httpAdminRoot !== false) {
        runtime.init(userSettings, httpServer, api);
        api.init(userSettings, httpServer, runtime.storage, runtime);
        api.httpAdmin.use(runtime.httpAdmin);
        apiEnabled = true;
        server = httpServer;
      } else {
        runtime.init(userSettings, httpServer);
        apiEnabled = false;
        if (httpServer) {
          server = httpServer;
        } else {
          server = null;
        }
      }
      return;
    },
    start: function() {
      let startPromise = runtime.start().then(function() {
        if (apiEnabled) {
          return api.start();
        }
      });
      startPromise._then = startPromise.then;
      startPromise.then = function(resolve, reject) {
        var inner = startPromise._then(resolve, reject);
        inner.otherwise = function(cb) {
          redUtil.log.error("**********************************************");
          redUtil.log.error("* Deprecated call to RED.start().otherwise() *");
          redUtil.log.error("* This will be removed in Node-RED 2.x       *");
          redUtil.log.error("* Use RED.start().catch() instead            *");
          redUtil.log.error("**********************************************");
          return inner.catch(cb);
        };
        return inner;
      };
      return startPromise;
    },
    stop: function() {
      return runtime.stop().then(function() {
        if (apiEnabled) {
          return api.stop();
        }
      });
    },
    log: redUtil.log,
    util: redUtil.util,
    get nodes() {
      return runtime._.nodes;
    },
    events: redUtil.events,
    hooks: runtime.hooks,
    get settings() {
      return runtime._.settings;
    },
    get version() {
      return runtime._.version;
    },
    get httpAdmin() {
      return api.httpAdmin;
    },
    get httpNode() {
      return runtime.httpNode;
    },
    get server() {
      return server;
    },
    runtime,
    auth: api.auth,
    get diagnostics() {
      return api.diagnostics;
    }
  };
});

// packages/node_modules/node-red/lib/bun-gateway.js
var require_bun_gateway = __commonJS((exports, module) => {
  var EventEmitter = __require("events");
  var routes = new Map;
  var bunServer = null;
  var proxyBaseUrl = null;
  var runningAddress = null;
  function normalizePath(path) {
    if (!path) {
      return "/";
    }
    return path.charAt(0) === "/" ? path : "/" + path;
  }
  function requestInfoFromWebRequest(request) {
    var headers = {};
    request.headers.forEach(function(value, key) {
      headers[key.toLowerCase()] = value;
    });
    return {
      method: request.method,
      url: request.url,
      headers
    };
  }
  function toMessageString(message) {
    if (typeof message === "string") {
      return message;
    }
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(message)) {
      return message.toString();
    }
    if (message instanceof Uint8Array || message instanceof ArrayBuffer) {
      return Buffer.from(message).toString();
    }
    return String(message);
  }
  async function handleFetch(request, serveServer) {
    var url = new URL(request.url);
    var route = routes.get(url.pathname);
    if (route) {
      var context = {};
      if (typeof route.authorize === "function") {
        context = await route.authorize(request);
        if (context && context.deny) {
          return new Response(context.body || "Unauthorized", { status: context.status || 401 });
        }
      }
      var upgraded = serveServer.upgrade(request, {
        data: {
          pathname: url.pathname,
          context: context || {},
          request: requestInfoFromWebRequest(request)
        }
      });
      if (upgraded) {
        return;
      }
      return new Response("Upgrade failed", { status: 500 });
    }
    if (!proxyBaseUrl) {
      return new Response("Not Found", { status: 404 });
    }
    var targetUrl = proxyBaseUrl + url.pathname + url.search;
    var init = {
      method: request.method,
      headers: request.headers,
      redirect: "manual"
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
    }
    return fetch(targetUrl, init);
  }
  function registerWebSocket(path, handlers) {
    var normalized = normalizePath(path);
    if (routes.has(normalized)) {
      throw new Error("WebSocket route already registered: " + normalized);
    }
    routes.set(normalized, handlers || {});
  }
  function unregisterWebSocket(path) {
    routes.delete(normalizePath(path));
  }
  function start(options) {
    if (!options || !options.hostname || options.port == null || !options.proxyBaseUrl) {
      throw new Error("bun-gateway start requires hostname, port and proxyBaseUrl");
    }
    proxyBaseUrl = options.proxyBaseUrl;
    if (bunServer) {
      return runningAddress;
    }
    bunServer = Bun.serve({
      hostname: options.hostname,
      port: options.port,
      fetch: handleFetch,
      websocket: {
        open: function(socket) {
          var route = routes.get(socket.data.pathname);
          if (route && typeof route.open === "function") {
            route.open(socket, socket.data.context || {}, socket.data.request || {});
          }
        },
        message: function(socket, message) {
          var route = routes.get(socket.data.pathname);
          if (route && typeof route.message === "function") {
            route.message(socket, toMessageString(message));
          }
        },
        close: function(socket, code, reason) {
          var route = routes.get(socket.data.pathname);
          if (route && typeof route.close === "function") {
            route.close(socket, code, reason);
          }
        },
        error: function(socket, error) {
          var route = routes.get(socket.data.pathname);
          if (route && typeof route.error === "function") {
            route.error(socket, error);
          }
        }
      }
    });
    runningAddress = {
      port: bunServer.port,
      hostname: options.hostname
    };
    return runningAddress;
  }
  function stop() {
    if (bunServer) {
      bunServer.stop(true);
      bunServer = null;
    }
    runningAddress = null;
    proxyBaseUrl = null;
  }
  function createServerFacade() {
    var emitter = new EventEmitter;
    var address = { port: 0, address: "127.0.0.1", family: "IPv4" };
    return {
      on: emitter.on.bind(emitter),
      once: emitter.once.bind(emitter),
      off: emitter.off ? emitter.off.bind(emitter) : function() {},
      emit: emitter.emit.bind(emitter),
      removeListener: emitter.removeListener.bind(emitter),
      setMaxListeners: emitter.setMaxListeners.bind(emitter),
      address: function() {
        return address;
      },
      __setAddress: function(a) {
        address = {
          port: a.port,
          address: a.hostname,
          family: "IPv4"
        };
        emitter.emit("listening");
      },
      listen: function(_port, _host, callback) {
        if (typeof callback === "function") {
          callback();
        }
      },
      close: function(callback) {
        if (typeof callback === "function") {
          callback();
        }
      }
    };
  }
  module.exports = {
    registerWebSocket,
    unregisterWebSocket,
    start,
    stop,
    createServerFacade
  };
});

// packages/node_modules/node-red/red.js
var require_red2 = __commonJS(() => {
  var __dirname = "C:\\Projekte\\node-red-bun\\packages\\node_modules\\node-red";
  if (process.argv[2] === "admin") {
    try {
      __require("node-red-admin")(process.argv.slice(3)).catch((err) => {
        process.exit(1);
      });
    } catch (err) {
      console.log(err);
    }
    return;
  }
  var semver = __require("semver");
  if (!semver.satisfies(process.version, ">=18.0.0")) {
    console.log("Unsupported version of Node.js:", process.version);
    console.log("Node-RED requires Node.js v18 or later");
    process.exit(1);
  }
  var http = __require("http");
  var https = __require("https");
  var util = __require("util");
  var express = __require("express");
  var crypto = __require("crypto");
  var bcrypt = __require("bcryptjs");
  var nopt = __require("nopt");
  var path = __require("path");
  var os = __require("os");
  var fs = __require("fs-extra");
  var cors = __require("cors");
  var RED = require_red();
  var bunGateway = require_bun_gateway();
  var server;
  var app = express();
  var settingsFile;
  var flowFile;
  var knownOpts = {
    help: Boolean,
    port: Number,
    settings: [path],
    title: String,
    userDir: [path],
    verbose: Boolean,
    safe: Boolean,
    version: Boolean,
    define: [String, Array],
    "no-telemetry": Boolean
  };
  var shortHands = {
    "?": ["--help"],
    p: ["--port"],
    s: ["--settings"],
    t: ["--help"],
    u: ["--userDir"],
    v: ["--verbose"],
    D: ["--define"]
  };
  nopt.invalidHandler = function(k2, v, t) {};
  var parsedArgs = nopt(knownOpts, shortHands, process.argv, 2);
  if (parsedArgs.help) {
    console.log("Node-RED v" + RED.version());
    console.log("Usage: node-red [-v] [-?] [--settings settings.js] [--userDir DIR]");
    console.log("                [--port PORT] [--title TITLE] [--safe] [flows.json]");
    console.log("       node-red admin <command> [args] [-?] [--userDir DIR] [--json]");
    console.log("");
    console.log("Options:");
    console.log("  -p, --port     PORT  port to listen on");
    console.log("  -s, --settings FILE  use specified settings file");
    console.log("      --title    TITLE process window title");
    console.log("  -u, --userDir  DIR   use specified user directory");
    console.log("  -v, --verbose        enable verbose output");
    console.log("      --safe           enable safe mode");
    console.log("  -D, --define   X=Y   overwrite value in settings file");
    console.log("      --version        show version information");
    console.log("      --no-telemetry   do not share usage data with the Node-RED project");
    console.log("  -?, --help           show this help");
    console.log("  admin <command>      run an admin command");
    console.log("");
    console.log("Documentation can be found at https://nodered.org");
    process.exit();
  }
  if (parsedArgs.version) {
    console.log("Node-RED v" + RED.version());
    console.log("Node.js " + process.version);
    console.log(os.type() + " " + os.release() + " " + os.arch() + " " + os.endianness());
    process.exit();
  }
  if (parsedArgs.argv.remain.length > 0) {
    flowFile = parsedArgs.argv.remain[0];
  }
  process.env.NODE_RED_HOME = process.env.NODE_RED_HOME || __dirname;
  if (parsedArgs.settings) {
    settingsFile = parsedArgs.settings;
  } else if (parsedArgs.userDir && fs.existsSync(path.join(parsedArgs.userDir, "settings.js"))) {
    settingsFile = path.join(parsedArgs.userDir, "settings.js");
  } else {
    if (fs.existsSync(path.join(process.env.NODE_RED_HOME, ".config.json"))) {
      settingsFile = path.join(process.env.NODE_RED_HOME, "settings.js");
    } else if (process.env.HOMEPATH && fs.existsSync(path.join(process.env.HOMEPATH, ".node-red", ".config.json"))) {
      settingsFile = path.join(process.env.HOMEPATH, ".node-red", "settings.js");
    } else {
      if (!parsedArgs.userDir && !(process.env.HOME || process.env.USERPROFILE || process.env.HOMEPATH)) {
        console.log("Could not find user directory. Ensure $HOME is set for the current user, or use --userDir option");
        process.exit(1);
      }
      userDir = parsedArgs.userDir || path.join(process.env.HOME || process.env.USERPROFILE || process.env.HOMEPATH, ".node-red");
      userSettingsFile = path.join(userDir, "settings.js");
      if (fs.existsSync(userSettingsFile)) {
        settingsFile = userSettingsFile;
      } else {
        defaultSettings = path.join(__dirname, "settings.js");
        settingsStat = fs.statSync(defaultSettings);
        if (settingsStat.mtime.getTime() <= settingsStat.ctime.getTime()) {
          fs.copySync(defaultSettings, userSettingsFile);
          settingsFile = userSettingsFile;
        } else {
          settingsFile = defaultSettings;
        }
      }
    }
  }
  var userDir;
  var userSettingsFile;
  var defaultSettings;
  var settingsStat;
  try {
    settings = __require(settingsFile);
    settings.settingsFile = settingsFile;
  } catch (err) {
    console.log("Error loading settings file: " + settingsFile);
    console.log(err);
    process.exit(1);
  }
  var settings;
  if (parsedArgs.define) {
    defs = parsedArgs.define;
    try {
      while (defs.length > 0) {
        def = defs.shift();
        match = /^(([^=]+)=(.+)|@(.*))$/.exec(def);
        if (match) {
          if (!match[4]) {
            val = match[3];
            try {
              val = JSON.parse(match[3]);
            } catch (err) {}
            RED.util.setObjectProperty(settings, match[2], val, true);
          } else {
            obj = fs.readJsonSync(match[4]);
            for (k in obj) {
              if (obj.hasOwnProperty(k)) {
                RED.util.setObjectProperty(settings, k, obj[k], true);
              }
            }
          }
        } else {
          throw new Error("Invalid syntax: '" + def + "'");
        }
      }
    } catch (e) {
      console.log("Error processing -D option: " + e.message);
      process.exit(1);
    }
  }
  var defs;
  var def;
  var match;
  var val;
  var obj;
  var k;
  if (parsedArgs.verbose) {
    settings.verbose = true;
  }
  if (parsedArgs.safe || process.env.NODE_RED_ENABLE_SAFE_MODE && !/^false$/i.test(process.env.NODE_RED_ENABLE_SAFE_MODE)) {
    settings.safeMode = true;
  }
  if (process.env.NODE_RED_ENABLE_PROJECTS) {
    settings.editorTheme = settings.editorTheme || {};
    settings.editorTheme.projects = settings.editorTheme.projects || {};
    settings.editorTheme.projects.enabled = !/^false$/i.test(process.env.NODE_RED_ENABLE_PROJECTS);
  }
  if (process.env.NODE_RED_ENABLE_TOURS) {
    settings.editorTheme = settings.editorTheme || {};
    settings.editorTheme.tours = !/^false$/i.test(process.env.NODE_RED_ENABLE_TOURS);
  }
  if (parsedArgs.telemetry === false || process.env.NODE_RED_DISABLE_TELEMETRY) {
    settings.telemetry = settings.telemetry || {};
    settings.telemetry.enabled = false;
  }
  var defaultServerSettings = {
    "x-powered-by": false
  };
  var serverSettings = Object.assign({}, defaultServerSettings, settings.httpServerOptions || {});
  for (eOption in serverSettings) {
    app.set(eOption, serverSettings[eOption]);
  }
  var eOption;
  var delayedLogItems = [];
  var startupHttps = settings.https;
  if (typeof startupHttps === "function") {
    startupHttps = startupHttps();
  }
  var httpsPromise = Promise.resolve(startupHttps);
  httpsPromise.then(function(startupHttps2) {
    if (startupHttps2) {
      server = https.createServer(startupHttps2, function(req, res) {
        app(req, res);
      });
      if (settings.httpsRefreshInterval) {
        var httpsRefreshInterval = parseFloat(settings.httpsRefreshInterval) || 12;
        if (httpsRefreshInterval > 596) {
          httpsRefreshInterval = 596;
        }
        if (typeof settings.https === "function") {
          delayedLogItems.push({ type: "info", id: "server.https.refresh-interval", params: { interval: httpsRefreshInterval } });
          setInterval(function() {
            try {
              Promise.resolve(settings.https()).then(function(refreshedHttps) {
                if (refreshedHttps) {
                  var updateKey = server.key == undefined || Buffer.isBuffer(server.key) && !server.key.equals(refreshedHttps.key) || typeof server.key == "string" && server.key != refreshedHttps.key;
                  var updateCert = server.cert == undefined || Buffer.isBuffer(server.cert) && !server.cert.equals(refreshedHttps.cert) || typeof server.cert == "string" && server.cert != refreshedHttps.cert;
                  if (updateKey || updateCert) {
                    server.setSecureContext(refreshedHttps);
                    RED.log.info(RED.log._("server.https.settings-refreshed"));
                  }
                }
              }).catch(function(err) {
                RED.log.error(RED.log._("server.https.refresh-failed", { message: err }));
              });
            } catch (err) {
              RED.log.error(RED.log._("server.https.refresh-failed", { message: err }));
            }
          }, httpsRefreshInterval * 60 * 60 * 1000);
        } else {
          delayedLogItems.push({ type: "warn", id: "server.https.function-required" });
        }
      }
    } else {
      server = http.createServer(function(req, res) {
        app(req, res);
      });
    }
    server.setMaxListeners(0);
    function formatRoot(root) {
      if (root[0] != "/") {
        root = "/" + root;
      }
      if (root.slice(-1) != "/") {
        root = root + "/";
      }
      return root;
    }
    if (settings.httpRoot === false) {
      settings.httpAdminRoot = false;
      settings.httpNodeRoot = false;
    } else {
      settings.disableEditor = settings.disableEditor || false;
    }
    if (settings.httpAdminRoot !== false) {
      settings.httpAdminRoot = formatRoot(settings.httpAdminRoot || settings.httpRoot || "/");
      settings.httpAdminAuth = settings.httpAdminAuth || settings.httpAuth;
    } else {
      settings.disableEditor = true;
    }
    if (settings.httpNodeRoot !== false) {
      settings.httpNodeRoot = formatRoot(settings.httpNodeRoot || settings.httpRoot || "/");
      settings.httpNodeAuth = settings.httpNodeAuth || settings.httpAuth;
    }
    if (settings.httpStatic) {
      settings.httpStaticRoot = formatRoot(settings.httpStaticRoot || "/");
      const statics = Array.isArray(settings.httpStatic) ? settings.httpStatic : [settings.httpStatic];
      const sanitised = [];
      for (let si = 0;si < statics.length; si++) {
        let sp = statics[si];
        if (typeof sp === "string") {
          sp = { path: sp, root: "" };
          sanitised.push(sp);
        } else if (typeof sp === "object" && sp.path) {
          sanitised.push(sp);
        } else {
          continue;
        }
        sp.subRoot = formatRoot(sp.root || "/");
        sp.root = formatRoot(path.posix.join(settings.httpStaticRoot, sp.subRoot));
      }
      settings.httpStatic = sanitised.length ? sanitised : false;
    }
    if (parsedArgs.port !== undefined) {
      settings.uiPort = parsedArgs.port;
    } else {
      if (settings.uiPort === undefined) {
        settings.uiPort = 1880;
      }
    }
    settings.uiHost = settings.uiHost || "0.0.0.0";
    if (flowFile) {
      settings.flowFile = flowFile;
    }
    if (parsedArgs.userDir) {
      settings.userDir = parsedArgs.userDir;
    }
    try {
      RED.init(server, settings);
    } catch (err) {
      if (err.code == "unsupported_version") {
        console.log("Unsupported version of Node.js:", process.version);
        console.log("Node-RED requires Node.js v18 or later");
      } else {
        console.log("Failed to start server:");
        if (err.stack) {
          console.log(err.stack);
        } else {
          console.log(err);
        }
      }
      process.exit(1);
    }
    function basicAuthMiddleware(user, pass) {
      var basicAuth = __require("basic-auth");
      var checkPassword;
      var localCachedPassword;
      if (pass.length == "32") {
        checkPassword = function(p) {
          return crypto.createHash("md5").update(p, "utf8").digest("hex") === pass;
        };
      } else {
        checkPassword = function(p) {
          return bcrypt.compareSync(p, pass);
        };
      }
      var checkPasswordAndCache = function(p) {
        if (localCachedPassword === p) {
          return true;
        }
        var result = checkPassword(p);
        if (result) {
          localCachedPassword = p;
        }
        return result;
      };
      return function(req, res, next) {
        if (req.method === "OPTIONS") {
          return next();
        }
        var requestUser = basicAuth(req);
        if (!requestUser || requestUser.name !== user || !checkPasswordAndCache(requestUser.pass)) {
          res.set("WWW-Authenticate", 'Basic realm="Authorization Required"');
          return res.sendStatus(401);
        }
        next();
      };
    }
    if (settings.httpAdminRoot !== false && settings.httpAdminAuth) {
      RED.log.warn(RED.log._("server.httpadminauth-deprecated"));
      app.use(settings.httpAdminRoot, basicAuthMiddleware(settings.httpAdminAuth.user, settings.httpAdminAuth.pass));
    }
    if (settings.httpAdminRoot !== false) {
      app.use(settings.httpAdminRoot, RED.httpAdmin);
    }
    if (settings.httpNodeRoot !== false && settings.httpNodeAuth) {
      if (typeof settings.httpNodeAuth === "function" || Array.isArray(settings.httpNodeAuth)) {
        app.use(settings.httpNodeRoot, settings.httpNodeAuth);
      } else {
        app.use(settings.httpNodeRoot, basicAuthMiddleware(settings.httpNodeAuth.user, settings.httpNodeAuth.pass));
      }
    }
    if (settings.httpNodeRoot !== false) {
      app.use(settings.httpNodeRoot, RED.httpNode);
    }
    if (settings.httpStatic) {
      let appUseMem = {};
      for (let si = 0;si < settings.httpStatic.length; si++) {
        const sp = settings.httpStatic[si];
        const filePath = sp.path;
        const thisRoot = sp.root || "/";
        const options = sp.options;
        const middleware = sp.middleware;
        const corsOptions = sp.cors || settings.httpStaticCors;
        if (appUseMem[filePath + "::" + thisRoot]) {
          continue;
        }
        appUseMem[filePath + "::" + thisRoot] = true;
        if (corsOptions) {
          const corsHandler = cors(corsOptions);
          app.options(thisRoot, corsHandler);
          app.use(thisRoot, corsHandler);
        }
        if (settings.httpStaticAuth) {
          app.use(thisRoot, basicAuthMiddleware(settings.httpStaticAuth.user, settings.httpStaticAuth.pass));
        }
        if (middleware) {
          app.use(thisRoot, middleware);
        }
        app.use(thisRoot, express.static(filePath, options));
      }
    }
    function getListenPath() {
      var port = settings.serverPort;
      if (port === undefined) {
        port = settings.uiPort;
      }
      var listenPath = "http" + (settings.https ? "s" : "") + "://" + (settings.uiHost == "::" ? "localhost" : settings.uiHost == "0.0.0.0" ? "127.0.0.1" : settings.uiHost) + ":" + port;
      if (settings.httpAdminRoot !== false) {
        listenPath += settings.httpAdminRoot;
      } else if (settings.httpStatic) {
        listenPath += "/";
      }
      return listenPath;
    }
    RED.start().then(function() {
      if (settings.httpAdminRoot !== false || settings.httpNodeRoot !== false || settings.httpStatic) {
        delayedLogItems.forEach(function(delayedLogItem, index) {
          RED.log[delayedLogItem.type](RED.log._(delayedLogItem.id, delayedLogItem.params || {}));
        });
        server.on("error", function(err) {
          RED.log.error(RED.log._("server.uncaught-exception"));
          if (err.stack) {
            RED.log.error(err.stack);
          } else {
            RED.log.error(err);
          }
          process.exit(1);
        });
        server.listen(0, "127.0.0.1", function() {
          var internalAddress = server.address();
          var proxyBaseUrl = "http" + (settings.https ? "s" : "") + "://127.0.0.1:" + internalAddress.port;
          try {
            var bunAddress = bunGateway.start({
              hostname: settings.uiHost,
              port: settings.uiPort,
              proxyBaseUrl
            });
            if (settings.httpAdminRoot === false) {
              RED.log.info(RED.log._("server.admin-ui-disabled"));
            }
            settings.serverPort = bunAddress.port;
            process.title = parsedArgs.title || "node-red";
            RED.log.info(RED.log._("server.now-running", { listenpath: getListenPath() }));
          } catch (err) {
            if (err.code === "EADDRINUSE") {
              RED.log.error(RED.log._("server.unable-to-listen", { listenpath: getListenPath() }));
              RED.log.error(RED.log._("server.port-in-use"));
            } else {
              RED.log.error(RED.log._("server.uncaught-exception"));
              if (err.stack) {
                RED.log.error(err.stack);
              } else {
                RED.log.error(err);
              }
            }
            process.exit(1);
          }
        });
      } else {
        RED.log.info(RED.log._("server.headless-mode"));
      }
    }).catch(function(err) {
      RED.log.error(RED.log._("server.failed-to-start"));
      if (err.stack) {
        RED.log.error(err.stack);
      } else {
        RED.log.error(err);
      }
    });
    process.on("uncaughtException", function(err) {
      console.log("[red] Uncaught Exception:");
      if (err.stack) {
        try {
          RED.log.error(err.stack);
        } catch (err2) {
          console.log(err.stack);
        }
      } else {
        try {
          RED.log.error(err);
        } catch (err2) {
          console.log(err);
        }
      }
      process.exit(1);
    });
    var stopping = false;
    function exitWhenStopped() {
      if (!stopping) {
        stopping = true;
        RED.stop().then(function() {
          bunGateway.stop();
          try {
            server.close(function() {
              process.exit();
            });
          } catch (err) {
            process.exit();
          }
        }).catch(function() {
          bunGateway.stop();
          process.exit();
        });
      }
    }
    process.on("SIGINT", exitWhenStopped);
    process.on("SIGTERM", exitWhenStopped);
    process.on("SIGHUP", exitWhenStopped);
    process.on("SIGUSR2", exitWhenStopped);
    process.on("SIGBREAK", exitWhenStopped);
    process.on("message", function(m) {
      if (m === "shutdown") {
        exitWhenStopped();
      }
    });
  }).catch(function(err) {
    console.log("Failed to get https settings: " + err);
    console.log(err.stack);
  });
});
export default require_red2();
