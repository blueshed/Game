"format global";
(function(global) {

  var defined = {};

  // indexOf polyfill for IE8
  var indexOf = Array.prototype.indexOf || function(item) {
    for (var i = 0, l = this.length; i < l; i++)
      if (this[i] === item)
        return i;
    return -1;
  }

  var getOwnPropertyDescriptor = true;
  try {
    Object.getOwnPropertyDescriptor({ a: 0 }, 'a');
  }
  catch(e) {
    getOwnPropertyDescriptor = false;
  }

  var defineProperty;
  (function () {
    try {
      if (!!Object.defineProperty({}, 'a', {}))
        defineProperty = Object.defineProperty;
    }
    catch (e) {
      defineProperty = function(obj, prop, opt) {
        try {
          obj[prop] = opt.value || opt.get.call(obj);
        }
        catch(e) {}
      }
    }
  })();

  function register(name, deps, declare) {
    if (arguments.length === 4)
      return registerDynamic.apply(this, arguments);
    doRegister(name, {
      declarative: true,
      deps: deps,
      declare: declare
    });
  }

  function registerDynamic(name, deps, executingRequire, execute) {
    doRegister(name, {
      declarative: false,
      deps: deps,
      executingRequire: executingRequire,
      execute: execute
    });
  }

  function doRegister(name, entry) {
    entry.name = name;

    // we never overwrite an existing define
    if (!(name in defined))
      defined[name] = entry;

    // we have to normalize dependencies
    // (assume dependencies are normalized for now)
    // entry.normalizedDeps = entry.deps.map(normalize);
    entry.normalizedDeps = entry.deps;
  }


  function buildGroups(entry, groups) {
    groups[entry.groupIndex] = groups[entry.groupIndex] || [];

    if (indexOf.call(groups[entry.groupIndex], entry) != -1)
      return;

    groups[entry.groupIndex].push(entry);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];

      // not in the registry means already linked / ES6
      if (!depEntry || depEntry.evaluated)
        continue;

      // now we know the entry is in our unlinked linkage group
      var depGroupIndex = entry.groupIndex + (depEntry.declarative != entry.declarative);

      // the group index of an entry is always the maximum
      if (depEntry.groupIndex === undefined || depEntry.groupIndex < depGroupIndex) {

        // if already in a group, remove from the old group
        if (depEntry.groupIndex !== undefined) {
          groups[depEntry.groupIndex].splice(indexOf.call(groups[depEntry.groupIndex], depEntry), 1);

          // if the old group is empty, then we have a mixed depndency cycle
          if (groups[depEntry.groupIndex].length == 0)
            throw new TypeError("Mixed dependency cycle detected");
        }

        depEntry.groupIndex = depGroupIndex;
      }

      buildGroups(depEntry, groups);
    }
  }

  function link(name) {
    var startEntry = defined[name];

    startEntry.groupIndex = 0;

    var groups = [];

    buildGroups(startEntry, groups);

    var curGroupDeclarative = !!startEntry.declarative == groups.length % 2;
    for (var i = groups.length - 1; i >= 0; i--) {
      var group = groups[i];
      for (var j = 0; j < group.length; j++) {
        var entry = group[j];

        // link each group
        if (curGroupDeclarative)
          linkDeclarativeModule(entry);
        else
          linkDynamicModule(entry);
      }
      curGroupDeclarative = !curGroupDeclarative; 
    }
  }

  // module binding records
  var moduleRecords = {};
  function getOrCreateModuleRecord(name) {
    return moduleRecords[name] || (moduleRecords[name] = {
      name: name,
      dependencies: [],
      exports: {}, // start from an empty module and extend
      importers: []
    })
  }

  function linkDeclarativeModule(entry) {
    // only link if already not already started linking (stops at circular)
    if (entry.module)
      return;

    var module = entry.module = getOrCreateModuleRecord(entry.name);
    var exports = entry.module.exports;

    var declaration = entry.declare.call(global, function(name, value) {
      module.locked = true;

      if (typeof name == 'object') {
        for (var p in name)
          exports[p] = name[p];
      }
      else {
        exports[name] = value;
      }

      for (var i = 0, l = module.importers.length; i < l; i++) {
        var importerModule = module.importers[i];
        if (!importerModule.locked) {
          for (var j = 0; j < importerModule.dependencies.length; ++j) {
            if (importerModule.dependencies[j] === module) {
              importerModule.setters[j](exports);
            }
          }
        }
      }

      module.locked = false;
      return value;
    });

    module.setters = declaration.setters;
    module.execute = declaration.execute;

    // now link all the module dependencies
    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];
      var depModule = moduleRecords[depName];

      // work out how to set depExports based on scenarios...
      var depExports;

      if (depModule) {
        depExports = depModule.exports;
      }
      else if (depEntry && !depEntry.declarative) {
        depExports = depEntry.esModule;
      }
      // in the module registry
      else if (!depEntry) {
        depExports = load(depName);
      }
      // we have an entry -> link
      else {
        linkDeclarativeModule(depEntry);
        depModule = depEntry.module;
        depExports = depModule.exports;
      }

      // only declarative modules have dynamic bindings
      if (depModule && depModule.importers) {
        depModule.importers.push(module);
        module.dependencies.push(depModule);
      }
      else
        module.dependencies.push(null);

      // run the setter for this dependency
      if (module.setters[i])
        module.setters[i](depExports);
    }
  }

  // An analog to loader.get covering execution of all three layers (real declarative, simulated declarative, simulated dynamic)
  function getModule(name) {
    var exports;
    var entry = defined[name];

    if (!entry) {
      exports = load(name);
      if (!exports)
        throw new Error("Unable to load dependency " + name + ".");
    }

    else {
      if (entry.declarative)
        ensureEvaluated(name, []);

      else if (!entry.evaluated)
        linkDynamicModule(entry);

      exports = entry.module.exports;
    }

    if ((!entry || entry.declarative) && exports && exports.__useDefault)
      return exports['default'];

    return exports;
  }

  function linkDynamicModule(entry) {
    if (entry.module)
      return;

    var exports = {};

    var module = entry.module = { exports: exports, id: entry.name };

    // AMD requires execute the tree first
    if (!entry.executingRequire) {
      for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
        var depName = entry.normalizedDeps[i];
        var depEntry = defined[depName];
        if (depEntry)
          linkDynamicModule(depEntry);
      }
    }

    // now execute
    entry.evaluated = true;
    var output = entry.execute.call(global, function(name) {
      for (var i = 0, l = entry.deps.length; i < l; i++) {
        if (entry.deps[i] != name)
          continue;
        return getModule(entry.normalizedDeps[i]);
      }
      throw new TypeError('Module ' + name + ' not declared as a dependency.');
    }, exports, module);

    if (output)
      module.exports = output;

    // create the esModule object, which allows ES6 named imports of dynamics
    exports = module.exports;
 
    if (exports && exports.__esModule) {
      entry.esModule = exports;
    }
    else {
      entry.esModule = {};
      
      // don't trigger getters/setters in environments that support them
      if (typeof exports == 'object' || typeof exports == 'function') {
        if (getOwnPropertyDescriptor) {
          var d;
          for (var p in exports)
            if (d = Object.getOwnPropertyDescriptor(exports, p))
              defineProperty(entry.esModule, p, d);
        }
        else {
          var hasOwnProperty = exports && exports.hasOwnProperty;
          for (var p in exports) {
            if (!hasOwnProperty || exports.hasOwnProperty(p))
              entry.esModule[p] = exports[p];
          }
         }
       }
      entry.esModule['default'] = exports;
      defineProperty(entry.esModule, '__useDefault', {
        value: true
      });
    }
  }

  /*
   * Given a module, and the list of modules for this current branch,
   *  ensure that each of the dependencies of this module is evaluated
   *  (unless one is a circular dependency already in the list of seen
   *  modules, in which case we execute it)
   *
   * Then we evaluate the module itself depth-first left to right 
   * execution to match ES6 modules
   */
  function ensureEvaluated(moduleName, seen) {
    var entry = defined[moduleName];

    // if already seen, that means it's an already-evaluated non circular dependency
    if (!entry || entry.evaluated || !entry.declarative)
      return;

    // this only applies to declarative modules which late-execute

    seen.push(moduleName);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      if (indexOf.call(seen, depName) == -1) {
        if (!defined[depName])
          load(depName);
        else
          ensureEvaluated(depName, seen);
      }
    }

    if (entry.evaluated)
      return;

    entry.evaluated = true;
    entry.module.execute.call(global);
  }

  // magical execution function
  var modules = {};
  function load(name) {
    if (modules[name])
      return modules[name];

    // node core modules
    if (name.substr(0, 6) == '@node/')
      return require(name.substr(6));

    var entry = defined[name];

    // first we check if this module has already been defined in the registry
    if (!entry)
      throw "Module " + name + " not present.";

    // recursively ensure that the module and all its 
    // dependencies are linked (with dependency group handling)
    link(name);

    // now handle dependency execution in correct order
    ensureEvaluated(name, []);

    // remove from the registry
    defined[name] = undefined;

    // exported modules get __esModule defined for interop
    if (entry.declarative)
      defineProperty(entry.module.exports, '__esModule', { value: true });

    // return the defined module object
    return modules[name] = entry.declarative ? entry.module.exports : entry.esModule;
  };

  return function(mains, depNames, declare) {
    return function(formatDetect) {
      formatDetect(function(deps) {
        var System = {
          _nodeRequire: typeof require != 'undefined' && require.resolve && typeof process != 'undefined' && require,
          register: register,
          registerDynamic: registerDynamic,
          get: load, 
          set: function(name, module) {
            modules[name] = module; 
          },
          newModule: function(module) {
            return module;
          }
        };
        System.set('@empty', {});

        // register external dependencies
        for (var i = 0; i < depNames.length; i++) (function(depName, dep) {
          if (dep && dep.__esModule)
            System.register(depName, [], function(_export) {
              return {
                setters: [],
                execute: function() {
                  for (var p in dep)
                    if (p != '__esModule' && !(typeof p == 'object' && p + '' == 'Module'))
                      _export(p, dep[p]);
                }
              };
            });
          else
            System.registerDynamic(depName, [], false, function() {
              return dep;
            });
        })(depNames[i], arguments[i]);

        // register modules in this bundle
        declare(System);

        // load mains
        var firstLoad = load(mains[0]);
        if (mains.length > 1)
          for (var i = 1; i < mains.length; i++)
            load(mains[i]);

        if (firstLoad.__useDefault)
          return firstLoad['default'];
        else
          return firstLoad;
      });
    };
  };

})(typeof self != 'undefined' ? self : global)
/* (['mainModule'], ['external-dep'], function($__System) {
  System.register(...);
})
(function(factory) {
  if (typeof define && define.amd)
    define(['external-dep'], factory);
  // etc UMD / module pattern
})*/

(['1'], [], function($__System) {

(function(__global) {
  var loader = $__System;
  var indexOf = Array.prototype.indexOf || function(item) {
    for (var i = 0, l = this.length; i < l; i++)
      if (this[i] === item)
        return i;
    return -1;
  }

  var commentRegEx = /(\/\*([\s\S]*?)\*\/|([^:]|^)\/\/(.*)$)/mg;
  var cjsRequirePre = "(?:^|[^$_a-zA-Z\\xA0-\\uFFFF.])";
  var cjsRequirePost = "\\s*\\(\\s*(\"([^\"]+)\"|'([^']+)')\\s*\\)";
  var fnBracketRegEx = /\(([^\)]*)\)/;
  var wsRegEx = /^\s+|\s+$/g;
  
  var requireRegExs = {};

  function getCJSDeps(source, requireIndex) {

    // remove comments
    source = source.replace(commentRegEx, '');

    // determine the require alias
    var params = source.match(fnBracketRegEx);
    var requireAlias = (params[1].split(',')[requireIndex] || 'require').replace(wsRegEx, '');

    // find or generate the regex for this requireAlias
    var requireRegEx = requireRegExs[requireAlias] || (requireRegExs[requireAlias] = new RegExp(cjsRequirePre + requireAlias + cjsRequirePost, 'g'));

    requireRegEx.lastIndex = 0;

    var deps = [];

    var match;
    while (match = requireRegEx.exec(source))
      deps.push(match[2] || match[3]);

    return deps;
  }

  /*
    AMD-compatible require
    To copy RequireJS, set window.require = window.requirejs = loader.amdRequire
  */
  function require(names, callback, errback, referer) {
    // in amd, first arg can be a config object... we just ignore
    if (typeof names == 'object' && !(names instanceof Array))
      return require.apply(null, Array.prototype.splice.call(arguments, 1, arguments.length - 1));

    // amd require
    if (typeof names == 'string' && typeof callback == 'function')
      names = [names];
    if (names instanceof Array) {
      var dynamicRequires = [];
      for (var i = 0; i < names.length; i++)
        dynamicRequires.push(loader['import'](names[i], referer));
      Promise.all(dynamicRequires).then(function(modules) {
        if (callback)
          callback.apply(null, modules);
      }, errback);
    }

    // commonjs require
    else if (typeof names == 'string') {
      var module = loader.get(names);
      return module.__useDefault ? module['default'] : module;
    }

    else
      throw new TypeError('Invalid require');
  }

  function define(name, deps, factory) {
    if (typeof name != 'string') {
      factory = deps;
      deps = name;
      name = null;
    }
    if (!(deps instanceof Array)) {
      factory = deps;
      deps = ['require', 'exports', 'module'].splice(0, factory.length);
    }

    if (typeof factory != 'function')
      factory = (function(factory) {
        return function() { return factory; }
      })(factory);

    // in IE8, a trailing comma becomes a trailing undefined entry
    if (deps[deps.length - 1] === undefined)
      deps.pop();

    // remove system dependencies
    var requireIndex, exportsIndex, moduleIndex;
    
    if ((requireIndex = indexOf.call(deps, 'require')) != -1) {
      
      deps.splice(requireIndex, 1);

      // only trace cjs requires for non-named
      // named defines assume the trace has already been done
      if (!name)
        deps = deps.concat(getCJSDeps(factory.toString(), requireIndex));
    }

    if ((exportsIndex = indexOf.call(deps, 'exports')) != -1)
      deps.splice(exportsIndex, 1);
    
    if ((moduleIndex = indexOf.call(deps, 'module')) != -1)
      deps.splice(moduleIndex, 1);

    var define = {
      name: name,
      deps: deps,
      execute: function(req, exports, module) {

        var depValues = [];
        for (var i = 0; i < deps.length; i++)
          depValues.push(req(deps[i]));

        module.uri = module.id;

        module.config = function() {};

        // add back in system dependencies
        if (moduleIndex != -1)
          depValues.splice(moduleIndex, 0, module);
        
        if (exportsIndex != -1)
          depValues.splice(exportsIndex, 0, exports);
        
        if (requireIndex != -1) 
          depValues.splice(requireIndex, 0, function(names, callback, errback) {
            if (typeof names == 'string' && typeof callback != 'function')
              return req(names);
            return require.call(loader, names, callback, errback, module.id);
          });

        var output = factory.apply(exportsIndex == -1 ? __global : exports, depValues);

        if (typeof output == 'undefined' && module)
          output = module.exports;

        if (typeof output != 'undefined')
          return output;
      }
    };

    // anonymous define
    if (!name) {
      // already defined anonymously -> throw
      if (lastModule.anonDefine)
        throw new TypeError('Multiple defines for anonymous module');
      lastModule.anonDefine = define;
    }
    // named define
    else {
      // if we don't have any other defines,
      // then let this be an anonymous define
      // this is just to support single modules of the form:
      // define('jquery')
      // still loading anonymously
      // because it is done widely enough to be useful
      if (!lastModule.anonDefine && !lastModule.isBundle) {
        lastModule.anonDefine = define;
      }
      // otherwise its a bundle only
      else {
        // if there is an anonDefine already (we thought it could have had a single named define)
        // then we define it now
        // this is to avoid defining named defines when they are actually anonymous
        if (lastModule.anonDefine && lastModule.anonDefine.name)
          loader.registerDynamic(lastModule.anonDefine.name, lastModule.anonDefine.deps, false, lastModule.anonDefine.execute);

        lastModule.anonDefine = null;
      }

      // note this is now a bundle
      lastModule.isBundle = true;

      // define the module through the register registry
      loader.registerDynamic(name, define.deps, false, define.execute);
    }
  }
  define.amd = {};

  // adds define as a global (potentially just temporarily)
  function createDefine(loader) {
    lastModule.anonDefine = null;
    lastModule.isBundle = false;

    // ensure no NodeJS environment detection
    var oldModule = __global.module;
    var oldExports = __global.exports;
    var oldDefine = __global.define;

    __global.module = undefined;
    __global.exports = undefined;
    __global.define = define;

    return function() {
      __global.define = oldDefine;
      __global.module = oldModule;
      __global.exports = oldExports;
    };
  }

  var lastModule = {
    isBundle: false,
    anonDefine: null
  };

  loader.set('@@amd-helpers', loader.newModule({
    createDefine: createDefine,
    require: require,
    define: define,
    lastModule: lastModule
  }));
  loader.amdDefine = define;
  loader.amdRequire = require;
})(typeof self != 'undefined' ? self : global);

"bundle";
$__System.register("2", [], function() { return { setters: [], execute: function() {} } });

(function() {
var _removeDefine = $__System.get("@@amd-helpers").createDefine();
define("3", [], function() {
  return "<div class=\"Main\">\n\t<div class=\"error\" v-if=\"error\">\n\t\t{{ error }}\n\t</div>\n\tWelcome {{ message }} <span class=\"on-line\" v-if=\"connected\">on-line</span><span class=\"off-line\" v-else>off-line</span>\n\t<div v-if=\"!game\">\n\t<form @submit.stop.prevent=\"create_game\">\n\t\t<input type=\"text\" v-model=\"username\"  placeholder=\"username\"/>\n\t\t<input type=\"text\" v-model=\"new_game_name\" placeholder=\"new game name\" />\n\t\t<input type=\"submit\" name=\"submit\" value=\"Add\"/>\n\t</form>\n\t<ul >\n\t\t<li v-for=\"game in games\">\n\t\t\t<a href=\"#\" @click.prevent=\"enter_game(game)\">{{ game }}</a>\n\t\t</li>\n\t</ul>\n\t</div>\n\t<div v-if=\"game\">\n\t\t<h1>{{ game.name }} - {{ username || 'host' }}</h1>\n\t\t<div>\n\t\t\t<h2>transcript</h2>\n\t\t\t<form @submit.stop.prevent=\"say\">\n\t\t\t\t<input type=\"text\" v-model=\"say_what\" placeholder=\"say something\">\n\t\t\t\t<input type=\"submit\" name=\"submit\" value=\"Say\"/>\n\t\t\t\t<button @click.prevent=\"leave_game\">leave game</button>\n\t\t\t</form>\n\t\t\t<div v-for=\"item in game.transcript\" track-by=\"$index\">\n\t\t\t\t{{ item.method }}\n\t\t\t\t<span v-if=\"item.signal=='said'\">\n\t\t\t\t\t{{ item.message.username || 'host' }} says: {{ item.message.said }}\n\t\t\t\t</span>\n\t\t\t\t<span v-else>{{item.signal}} {{ item.message }}</span>\n\t\t\t</div>\n\t\t</div>\n\t\t<div v-if=\"!username\" style=\"padding:5em;\">\n\t\t\t<div v-for=\"user in game.users\" :style=\"{transform: rotation($index)}\">\n\t\t\t\t<div style=\"display:inline-block;transform: rotate(90deg);\">\n\t\t\t\t\t{{ user }} {{ rotation($index) }}\n\t\t\t\t</div>\n\t\t\t</div>\n\t\t</div>\n\t</div>\n</div>\n";
});

_removeDefine();
})();
$__System.registerDynamic("4", [], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var process = module.exports = {};
  var queue = [];
  var draining = false;
  var currentQueue;
  var queueIndex = -1;
  function cleanUpNextTick() {
    draining = false;
    if (currentQueue.length) {
      queue = currentQueue.concat(queue);
    } else {
      queueIndex = -1;
    }
    if (queue.length) {
      drainQueue();
    }
  }
  function drainQueue() {
    if (draining) {
      return;
    }
    var timeout = setTimeout(cleanUpNextTick);
    draining = true;
    var len = queue.length;
    while (len) {
      currentQueue = queue;
      queue = [];
      while (++queueIndex < len) {
        if (currentQueue) {
          currentQueue[queueIndex].run();
        }
      }
      queueIndex = -1;
      len = queue.length;
    }
    currentQueue = null;
    draining = false;
    clearTimeout(timeout);
  }
  process.nextTick = function(fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
      for (var i = 1; i < arguments.length; i++) {
        args[i - 1] = arguments[i];
      }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
      setTimeout(drainQueue, 0);
    }
  };
  function Item(fun, array) {
    this.fun = fun;
    this.array = array;
  }
  Item.prototype.run = function() {
    this.fun.apply(null, this.array);
  };
  process.title = 'browser';
  process.browser = true;
  process.env = {};
  process.argv = [];
  process.version = '';
  process.versions = {};
  function noop() {}
  process.on = noop;
  process.addListener = noop;
  process.once = noop;
  process.off = noop;
  process.removeListener = noop;
  process.removeAllListeners = noop;
  process.emit = noop;
  process.binding = function(name) {
    throw new Error('process.binding is not supported');
  };
  process.cwd = function() {
    return '/';
  };
  process.chdir = function(dir) {
    throw new Error('process.chdir is not supported');
  };
  process.umask = function() {
    return 0;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("5", ["4"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = req('4');
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("6", ["5"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = $__System._nodeRequire ? process : req('5');
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("7", ["6"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = req('6');
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("8", ["7"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  "format cjs";
  (function(process) {
    !function(e) {
      if ("object" == typeof exports && "undefined" != typeof module)
        module.exports = e();
      else if ("function" == typeof define && define.amd)
        define([], e);
      else {
        var f;
        "undefined" != typeof window ? f = window : "undefined" != typeof global ? f = global : "undefined" != typeof self && (f = self), f.Promise = e();
      }
    }(function() {
      var define,
          module,
          exports;
      return (function e(t, n, r) {
        function s(o, u) {
          if (!n[o]) {
            if (!t[o]) {
              var a = typeof _dereq_ == "function" && _dereq_;
              if (!u && a)
                return a(o, !0);
              if (i)
                return i(o, !0);
              var f = new Error("Cannot find module '" + o + "'");
              throw f.code = "MODULE_NOT_FOUND", f;
            }
            var l = n[o] = {exports: {}};
            t[o][0].call(l.exports, function(e) {
              var n = t[o][1][e];
              return s(n ? n : e);
            }, l, l.exports, e, t, n, r);
          }
          return n[o].exports;
        }
        var i = typeof _dereq_ == "function" && _dereq_;
        for (var o = 0; o < r.length; o++)
          s(r[o]);
        return s;
      })({
        1: [function(_dereq_, module, exports) {
          "use strict";
          module.exports = function(Promise) {
            var SomePromiseArray = Promise._SomePromiseArray;
            function any(promises) {
              var ret = new SomePromiseArray(promises);
              var promise = ret.promise();
              ret.setHowMany(1);
              ret.setUnwrap();
              ret.init();
              return promise;
            }
            Promise.any = function(promises) {
              return any(promises);
            };
            Promise.prototype.any = function() {
              return any(this);
            };
          };
        }, {}],
        2: [function(_dereq_, module, exports) {
          "use strict";
          var firstLineError;
          try {
            throw new Error();
          } catch (e) {
            firstLineError = e;
          }
          var schedule = _dereq_("./schedule");
          var Queue = _dereq_("./queue");
          var util = _dereq_("./util");
          function Async() {
            this._isTickUsed = false;
            this._lateQueue = new Queue(16);
            this._normalQueue = new Queue(16);
            this._haveDrainedQueues = false;
            this._trampolineEnabled = true;
            var self = this;
            this.drainQueues = function() {
              self._drainQueues();
            };
            this._schedule = schedule;
          }
          Async.prototype.enableTrampoline = function() {
            this._trampolineEnabled = true;
          };
          Async.prototype.disableTrampolineIfNecessary = function() {
            if (util.hasDevTools) {
              this._trampolineEnabled = false;
            }
          };
          Async.prototype.haveItemsQueued = function() {
            return this._isTickUsed || this._haveDrainedQueues;
          };
          Async.prototype.fatalError = function(e, isNode) {
            if (isNode) {
              process.stderr.write("Fatal " + (e instanceof Error ? e.stack : e));
              process.exit(2);
            } else {
              this.throwLater(e);
            }
          };
          Async.prototype.throwLater = function(fn, arg) {
            if (arguments.length === 1) {
              arg = fn;
              fn = function() {
                throw arg;
              };
            }
            if (typeof setTimeout !== "undefined") {
              setTimeout(function() {
                fn(arg);
              }, 0);
            } else
              try {
                this._schedule(function() {
                  fn(arg);
                });
              } catch (e) {
                throw new Error("No async scheduler available\u000a\u000a    See http://goo.gl/MqrFmX\u000a");
              }
          };
          function AsyncInvokeLater(fn, receiver, arg) {
            this._lateQueue.push(fn, receiver, arg);
            this._queueTick();
          }
          function AsyncInvoke(fn, receiver, arg) {
            this._normalQueue.push(fn, receiver, arg);
            this._queueTick();
          }
          function AsyncSettlePromises(promise) {
            this._normalQueue._pushOne(promise);
            this._queueTick();
          }
          if (!util.hasDevTools) {
            Async.prototype.invokeLater = AsyncInvokeLater;
            Async.prototype.invoke = AsyncInvoke;
            Async.prototype.settlePromises = AsyncSettlePromises;
          } else {
            Async.prototype.invokeLater = function(fn, receiver, arg) {
              if (this._trampolineEnabled) {
                AsyncInvokeLater.call(this, fn, receiver, arg);
              } else {
                this._schedule(function() {
                  setTimeout(function() {
                    fn.call(receiver, arg);
                  }, 100);
                });
              }
            };
            Async.prototype.invoke = function(fn, receiver, arg) {
              if (this._trampolineEnabled) {
                AsyncInvoke.call(this, fn, receiver, arg);
              } else {
                this._schedule(function() {
                  fn.call(receiver, arg);
                });
              }
            };
            Async.prototype.settlePromises = function(promise) {
              if (this._trampolineEnabled) {
                AsyncSettlePromises.call(this, promise);
              } else {
                this._schedule(function() {
                  promise._settlePromises();
                });
              }
            };
          }
          Async.prototype.invokeFirst = function(fn, receiver, arg) {
            this._normalQueue.unshift(fn, receiver, arg);
            this._queueTick();
          };
          Async.prototype._drainQueue = function(queue) {
            while (queue.length() > 0) {
              var fn = queue.shift();
              if (typeof fn !== "function") {
                fn._settlePromises();
                continue;
              }
              var receiver = queue.shift();
              var arg = queue.shift();
              fn.call(receiver, arg);
            }
          };
          Async.prototype._drainQueues = function() {
            this._drainQueue(this._normalQueue);
            this._reset();
            this._haveDrainedQueues = true;
            this._drainQueue(this._lateQueue);
          };
          Async.prototype._queueTick = function() {
            if (!this._isTickUsed) {
              this._isTickUsed = true;
              this._schedule(this.drainQueues);
            }
          };
          Async.prototype._reset = function() {
            this._isTickUsed = false;
          };
          module.exports = Async;
          module.exports.firstLineError = firstLineError;
        }, {
          "./queue": 26,
          "./schedule": 29,
          "./util": 36
        }],
        3: [function(_dereq_, module, exports) {
          "use strict";
          module.exports = function(Promise, INTERNAL, tryConvertToPromise, debug) {
            var calledBind = false;
            var rejectThis = function(_, e) {
              this._reject(e);
            };
            var targetRejected = function(e, context) {
              context.promiseRejectionQueued = true;
              context.bindingPromise._then(rejectThis, rejectThis, null, this, e);
            };
            var bindingResolved = function(thisArg, context) {
              if (((this._bitField & 50397184) === 0)) {
                this._resolveCallback(context.target);
              }
            };
            var bindingRejected = function(e, context) {
              if (!context.promiseRejectionQueued)
                this._reject(e);
            };
            Promise.prototype.bind = function(thisArg) {
              if (!calledBind) {
                calledBind = true;
                Promise.prototype._propagateFrom = debug.propagateFromFunction();
                Promise.prototype._boundValue = debug.boundValueFunction();
              }
              var maybePromise = tryConvertToPromise(thisArg);
              var ret = new Promise(INTERNAL);
              ret._propagateFrom(this, 1);
              var target = this._target();
              ret._setBoundTo(maybePromise);
              if (maybePromise instanceof Promise) {
                var context = {
                  promiseRejectionQueued: false,
                  promise: ret,
                  target: target,
                  bindingPromise: maybePromise
                };
                target._then(INTERNAL, targetRejected, undefined, ret, context);
                maybePromise._then(bindingResolved, bindingRejected, undefined, ret, context);
                ret._setOnCancel(maybePromise);
              } else {
                ret._resolveCallback(target);
              }
              return ret;
            };
            Promise.prototype._setBoundTo = function(obj) {
              if (obj !== undefined) {
                this._bitField = this._bitField | 2097152;
                this._boundTo = obj;
              } else {
                this._bitField = this._bitField & (~2097152);
              }
            };
            Promise.prototype._isBound = function() {
              return (this._bitField & 2097152) === 2097152;
            };
            Promise.bind = function(thisArg, value) {
              return Promise.resolve(value).bind(thisArg);
            };
          };
        }, {}],
        4: [function(_dereq_, module, exports) {
          "use strict";
          var old;
          if (typeof Promise !== "undefined")
            old = Promise;
          function noConflict() {
            try {
              if (Promise === bluebird)
                Promise = old;
            } catch (e) {}
            return bluebird;
          }
          var bluebird = _dereq_("./promise")();
          bluebird.noConflict = noConflict;
          module.exports = bluebird;
        }, {"./promise": 22}],
        5: [function(_dereq_, module, exports) {
          "use strict";
          var cr = Object.create;
          if (cr) {
            var callerCache = cr(null);
            var getterCache = cr(null);
            callerCache[" size"] = getterCache[" size"] = 0;
          }
          module.exports = function(Promise) {
            var util = _dereq_("./util");
            var canEvaluate = util.canEvaluate;
            var isIdentifier = util.isIdentifier;
            var getMethodCaller;
            var getGetter;
            if (!true) {
              var makeMethodCaller = function(methodName) {
                return new Function("ensureMethod", "                                    \n\
        return function(obj) {                                               \n\
            'use strict'                                                     \n\
            var len = this.length;                                           \n\
            ensureMethod(obj, 'methodName');                                 \n\
            switch(len) {                                                    \n\
                case 1: return obj.methodName(this[0]);                      \n\
                case 2: return obj.methodName(this[0], this[1]);             \n\
                case 3: return obj.methodName(this[0], this[1], this[2]);    \n\
                case 0: return obj.methodName();                             \n\
                default:                                                     \n\
                    return obj.methodName.apply(obj, this);                  \n\
            }                                                                \n\
        };                                                                   \n\
        ".replace(/methodName/g, methodName))(ensureMethod);
              };
              var makeGetter = function(propertyName) {
                return new Function("obj", "                                             \n\
        'use strict';                                                        \n\
        return obj.propertyName;                                             \n\
        ".replace("propertyName", propertyName));
              };
              var getCompiled = function(name, compiler, cache) {
                var ret = cache[name];
                if (typeof ret !== "function") {
                  if (!isIdentifier(name)) {
                    return null;
                  }
                  ret = compiler(name);
                  cache[name] = ret;
                  cache[" size"]++;
                  if (cache[" size"] > 512) {
                    var keys = Object.keys(cache);
                    for (var i = 0; i < 256; ++i)
                      delete cache[keys[i]];
                    cache[" size"] = keys.length - 256;
                  }
                }
                return ret;
              };
              getMethodCaller = function(name) {
                return getCompiled(name, makeMethodCaller, callerCache);
              };
              getGetter = function(name) {
                return getCompiled(name, makeGetter, getterCache);
              };
            }
            function ensureMethod(obj, methodName) {
              var fn;
              if (obj != null)
                fn = obj[methodName];
              if (typeof fn !== "function") {
                var message = "Object " + util.classString(obj) + " has no method '" + util.toString(methodName) + "'";
                throw new Promise.TypeError(message);
              }
              return fn;
            }
            function caller(obj) {
              var methodName = this.pop();
              var fn = ensureMethod(obj, methodName);
              return fn.apply(obj, this);
            }
            Promise.prototype.call = function(methodName) {
              var args = [].slice.call(arguments, 1);
              ;
              if (!true) {
                if (canEvaluate) {
                  var maybeCaller = getMethodCaller(methodName);
                  if (maybeCaller !== null) {
                    return this._then(maybeCaller, undefined, undefined, args, undefined);
                  }
                }
              }
              args.push(methodName);
              return this._then(caller, undefined, undefined, args, undefined);
            };
            function namedGetter(obj) {
              return obj[this];
            }
            function indexedGetter(obj) {
              var index = +this;
              if (index < 0)
                index = Math.max(0, index + obj.length);
              return obj[index];
            }
            Promise.prototype.get = function(propertyName) {
              var isIndex = (typeof propertyName === "number");
              var getter;
              if (!isIndex) {
                if (canEvaluate) {
                  var maybeGetter = getGetter(propertyName);
                  getter = maybeGetter !== null ? maybeGetter : namedGetter;
                } else {
                  getter = namedGetter;
                }
              } else {
                getter = indexedGetter;
              }
              return this._then(getter, undefined, undefined, propertyName, undefined);
            };
          };
        }, {"./util": 36}],
        6: [function(_dereq_, module, exports) {
          "use strict";
          module.exports = function(Promise, PromiseArray, apiRejection, debug) {
            var util = _dereq_("./util");
            var tryCatch = util.tryCatch;
            var errorObj = util.errorObj;
            var async = Promise._async;
            Promise.prototype["break"] = Promise.prototype.cancel = function() {
              if (!debug.cancellation())
                return this._warn("cancellation is disabled");
              var promise = this;
              var child = promise;
              while (promise.isCancellable()) {
                if (!promise._cancelBy(child)) {
                  if (child._isFollowing()) {
                    child._followee().cancel();
                  } else {
                    child._cancelBranched();
                  }
                  break;
                }
                var parent = promise._cancellationParent;
                if (parent == null || !parent.isCancellable()) {
                  if (promise._isFollowing()) {
                    promise._followee().cancel();
                  } else {
                    promise._cancelBranched();
                  }
                  break;
                } else {
                  if (promise._isFollowing())
                    promise._followee().cancel();
                  child = promise;
                  promise = parent;
                }
              }
            };
            Promise.prototype._branchHasCancelled = function() {
              this._branchesRemainingToCancel--;
            };
            Promise.prototype._enoughBranchesHaveCancelled = function() {
              return this._branchesRemainingToCancel === undefined || this._branchesRemainingToCancel <= 0;
            };
            Promise.prototype._cancelBy = function(canceller) {
              if (canceller === this) {
                this._branchesRemainingToCancel = 0;
                this._invokeOnCancel();
                return true;
              } else {
                this._branchHasCancelled();
                if (this._enoughBranchesHaveCancelled()) {
                  this._invokeOnCancel();
                  return true;
                }
              }
              return false;
            };
            Promise.prototype._cancelBranched = function() {
              if (this._enoughBranchesHaveCancelled()) {
                this._cancel();
              }
            };
            Promise.prototype._cancel = function() {
              if (!this.isCancellable())
                return;
              this._setCancelled();
              async.invoke(this._cancelPromises, this, undefined);
            };
            Promise.prototype._cancelPromises = function() {
              if (this._length() > 0)
                this._settlePromises();
            };
            Promise.prototype._unsetOnCancel = function() {
              this._onCancelField = undefined;
            };
            Promise.prototype.isCancellable = function() {
              return this.isPending() && !this.isCancelled();
            };
            Promise.prototype._doInvokeOnCancel = function(onCancelCallback, internalOnly) {
              if (util.isArray(onCancelCallback)) {
                for (var i = 0; i < onCancelCallback.length; ++i) {
                  this._doInvokeOnCancel(onCancelCallback[i], internalOnly);
                }
              } else if (onCancelCallback !== undefined) {
                if (typeof onCancelCallback === "function") {
                  if (!internalOnly) {
                    var e = tryCatch(onCancelCallback).call(this._boundValue());
                    if (e === errorObj) {
                      this._attachExtraTrace(e.e);
                      async.throwLater(e.e);
                    }
                  }
                } else {
                  onCancelCallback._resultCancelled(this);
                }
              }
            };
            Promise.prototype._invokeOnCancel = function() {
              var onCancelCallback = this._onCancel();
              this._unsetOnCancel();
              async.invoke(this._doInvokeOnCancel, this, onCancelCallback);
            };
            Promise.prototype._invokeInternalOnCancel = function() {
              if (this.isCancellable()) {
                this._doInvokeOnCancel(this._onCancel(), true);
                this._unsetOnCancel();
              }
            };
            Promise.prototype._resultCancelled = function() {
              this.cancel();
            };
          };
        }, {"./util": 36}],
        7: [function(_dereq_, module, exports) {
          "use strict";
          module.exports = function(NEXT_FILTER) {
            var util = _dereq_("./util");
            var getKeys = _dereq_("./es5").keys;
            var tryCatch = util.tryCatch;
            var errorObj = util.errorObj;
            function catchFilter(instances, cb, promise) {
              return function(e) {
                var boundTo = promise._boundValue();
                predicateLoop: for (var i = 0; i < instances.length; ++i) {
                  var item = instances[i];
                  if (item === Error || (item != null && item.prototype instanceof Error)) {
                    if (e instanceof item) {
                      return tryCatch(cb).call(boundTo, e);
                    }
                  } else if (typeof item === "function") {
                    var matchesPredicate = tryCatch(item).call(boundTo, e);
                    if (matchesPredicate === errorObj) {
                      return matchesPredicate;
                    } else if (matchesPredicate) {
                      return tryCatch(cb).call(boundTo, e);
                    }
                  } else if (util.isObject(e)) {
                    var keys = getKeys(item);
                    for (var j = 0; j < keys.length; ++j) {
                      var key = keys[j];
                      if (item[key] != e[key]) {
                        continue predicateLoop;
                      }
                    }
                    return tryCatch(cb).call(boundTo, e);
                  }
                }
                return NEXT_FILTER;
              };
            }
            return catchFilter;
          };
        }, {
          "./es5": 13,
          "./util": 36
        }],
        8: [function(_dereq_, module, exports) {
          "use strict";
          module.exports = function(Promise) {
            var longStackTraces = false;
            var contextStack = [];
            Promise.prototype._promiseCreated = function() {};
            Promise.prototype._pushContext = function() {};
            Promise.prototype._popContext = function() {
              return null;
            };
            Promise._peekContext = Promise.prototype._peekContext = function() {};
            function Context() {
              this._trace = new Context.CapturedTrace(peekContext());
            }
            Context.prototype._pushContext = function() {
              if (this._trace !== undefined) {
                this._trace._promiseCreated = null;
                contextStack.push(this._trace);
              }
            };
            Context.prototype._popContext = function() {
              if (this._trace !== undefined) {
                var trace = contextStack.pop();
                var ret = trace._promiseCreated;
                trace._promiseCreated = null;
                return ret;
              }
              return null;
            };
            function createContext() {
              if (longStackTraces)
                return new Context();
            }
            function peekContext() {
              var lastIndex = contextStack.length - 1;
              if (lastIndex >= 0) {
                return contextStack[lastIndex];
              }
              return undefined;
            }
            Context.CapturedTrace = null;
            Context.create = createContext;
            Context.deactivateLongStackTraces = function() {};
            Context.activateLongStackTraces = function() {
              var Promise_pushContext = Promise.prototype._pushContext;
              var Promise_popContext = Promise.prototype._popContext;
              var Promise_PeekContext = Promise._peekContext;
              var Promise_peekContext = Promise.prototype._peekContext;
              var Promise_promiseCreated = Promise.prototype._promiseCreated;
              Context.deactivateLongStackTraces = function() {
                Promise.prototype._pushContext = Promise_pushContext;
                Promise.prototype._popContext = Promise_popContext;
                Promise._peekContext = Promise_PeekContext;
                Promise.prototype._peekContext = Promise_peekContext;
                Promise.prototype._promiseCreated = Promise_promiseCreated;
                longStackTraces = false;
              };
              longStackTraces = true;
              Promise.prototype._pushContext = Context.prototype._pushContext;
              Promise.prototype._popContext = Context.prototype._popContext;
              Promise._peekContext = Promise.prototype._peekContext = peekContext;
              Promise.prototype._promiseCreated = function() {
                var ctx = this._peekContext();
                if (ctx && ctx._promiseCreated == null)
                  ctx._promiseCreated = this;
              };
            };
            return Context;
          };
        }, {}],
        9: [function(_dereq_, module, exports) {
          "use strict";
          module.exports = function(Promise, Context) {
            var getDomain = Promise._getDomain;
            var async = Promise._async;
            var Warning = _dereq_("./errors").Warning;
            var util = _dereq_("./util");
            var canAttachTrace = util.canAttachTrace;
            var unhandledRejectionHandled;
            var possiblyUnhandledRejection;
            var bluebirdFramePattern = /[\\\/]bluebird[\\\/]js[\\\/](release|debug|instrumented)/;
            var stackFramePattern = null;
            var formatStack = null;
            var indentStackFrames = false;
            var printWarning;
            var debugging = !!(util.env("BLUEBIRD_DEBUG") != 0 && (true || util.env("BLUEBIRD_DEBUG") || util.env("NODE_ENV") === "development"));
            var warnings = !!(util.env("BLUEBIRD_WARNINGS") != 0 && (debugging || util.env("BLUEBIRD_WARNINGS")));
            var longStackTraces = !!(util.env("BLUEBIRD_LONG_STACK_TRACES") != 0 && (debugging || util.env("BLUEBIRD_LONG_STACK_TRACES")));
            var wForgottenReturn = util.env("BLUEBIRD_W_FORGOTTEN_RETURN") != 0 && (warnings || !!util.env("BLUEBIRD_W_FORGOTTEN_RETURN"));
            Promise.prototype.suppressUnhandledRejections = function() {
              var target = this._target();
              target._bitField = ((target._bitField & (~1048576)) | 524288);
            };
            Promise.prototype._ensurePossibleRejectionHandled = function() {
              if ((this._bitField & 524288) !== 0)
                return;
              this._setRejectionIsUnhandled();
              async.invokeLater(this._notifyUnhandledRejection, this, undefined);
            };
            Promise.prototype._notifyUnhandledRejectionIsHandled = function() {
              fireRejectionEvent("rejectionHandled", unhandledRejectionHandled, undefined, this);
            };
            Promise.prototype._setReturnedNonUndefined = function() {
              this._bitField = this._bitField | 268435456;
            };
            Promise.prototype._returnedNonUndefined = function() {
              return (this._bitField & 268435456) !== 0;
            };
            Promise.prototype._notifyUnhandledRejection = function() {
              if (this._isRejectionUnhandled()) {
                var reason = this._settledValue();
                this._setUnhandledRejectionIsNotified();
                fireRejectionEvent("unhandledRejection", possiblyUnhandledRejection, reason, this);
              }
            };
            Promise.prototype._setUnhandledRejectionIsNotified = function() {
              this._bitField = this._bitField | 262144;
            };
            Promise.prototype._unsetUnhandledRejectionIsNotified = function() {
              this._bitField = this._bitField & (~262144);
            };
            Promise.prototype._isUnhandledRejectionNotified = function() {
              return (this._bitField & 262144) > 0;
            };
            Promise.prototype._setRejectionIsUnhandled = function() {
              this._bitField = this._bitField | 1048576;
            };
            Promise.prototype._unsetRejectionIsUnhandled = function() {
              this._bitField = this._bitField & (~1048576);
              if (this._isUnhandledRejectionNotified()) {
                this._unsetUnhandledRejectionIsNotified();
                this._notifyUnhandledRejectionIsHandled();
              }
            };
            Promise.prototype._isRejectionUnhandled = function() {
              return (this._bitField & 1048576) > 0;
            };
            Promise.prototype._warn = function(message, shouldUseOwnTrace, promise) {
              return warn(message, shouldUseOwnTrace, promise || this);
            };
            Promise.onPossiblyUnhandledRejection = function(fn) {
              var domain = getDomain();
              possiblyUnhandledRejection = typeof fn === "function" ? (domain === null ? fn : domain.bind(fn)) : undefined;
            };
            Promise.onUnhandledRejectionHandled = function(fn) {
              var domain = getDomain();
              unhandledRejectionHandled = typeof fn === "function" ? (domain === null ? fn : domain.bind(fn)) : undefined;
            };
            var disableLongStackTraces = function() {};
            Promise.longStackTraces = function() {
              if (async.haveItemsQueued() && !config.longStackTraces) {
                throw new Error("cannot enable long stack traces after promises have been created\u000a\u000a    See http://goo.gl/MqrFmX\u000a");
              }
              if (!config.longStackTraces && longStackTracesIsSupported()) {
                var Promise_captureStackTrace = Promise.prototype._captureStackTrace;
                var Promise_attachExtraTrace = Promise.prototype._attachExtraTrace;
                config.longStackTraces = true;
                disableLongStackTraces = function() {
                  if (async.haveItemsQueued() && !config.longStackTraces) {
                    throw new Error("cannot enable long stack traces after promises have been created\u000a\u000a    See http://goo.gl/MqrFmX\u000a");
                  }
                  Promise.prototype._captureStackTrace = Promise_captureStackTrace;
                  Promise.prototype._attachExtraTrace = Promise_attachExtraTrace;
                  Context.deactivateLongStackTraces();
                  async.enableTrampoline();
                  config.longStackTraces = false;
                };
                Promise.prototype._captureStackTrace = longStackTracesCaptureStackTrace;
                Promise.prototype._attachExtraTrace = longStackTracesAttachExtraTrace;
                Context.activateLongStackTraces();
                async.disableTrampolineIfNecessary();
              }
            };
            Promise.hasLongStackTraces = function() {
              return config.longStackTraces && longStackTracesIsSupported();
            };
            Promise.config = function(opts) {
              opts = Object(opts);
              if ("longStackTraces" in opts) {
                if (opts.longStackTraces) {
                  Promise.longStackTraces();
                } else if (!opts.longStackTraces && Promise.hasLongStackTraces()) {
                  disableLongStackTraces();
                }
              }
              if ("warnings" in opts) {
                var warningsOption = opts.warnings;
                config.warnings = !!warningsOption;
                wForgottenReturn = config.warnings;
                if (util.isObject(warningsOption)) {
                  if ("wForgottenReturn" in warningsOption) {
                    wForgottenReturn = !!warningsOption.wForgottenReturn;
                  }
                }
              }
              if ("cancellation" in opts && opts.cancellation && !config.cancellation) {
                if (async.haveItemsQueued()) {
                  throw new Error("cannot enable cancellation after promises are in use");
                }
                Promise.prototype._clearCancellationData = cancellationClearCancellationData;
                Promise.prototype._propagateFrom = cancellationPropagateFrom;
                Promise.prototype._onCancel = cancellationOnCancel;
                Promise.prototype._setOnCancel = cancellationSetOnCancel;
                Promise.prototype._attachCancellationCallback = cancellationAttachCancellationCallback;
                Promise.prototype._execute = cancellationExecute;
                propagateFromFunction = cancellationPropagateFrom;
                config.cancellation = true;
              }
            };
            Promise.prototype._execute = function(executor, resolve, reject) {
              try {
                executor(resolve, reject);
              } catch (e) {
                return e;
              }
            };
            Promise.prototype._onCancel = function() {};
            Promise.prototype._setOnCancel = function(handler) {
              ;
            };
            Promise.prototype._attachCancellationCallback = function(onCancel) {
              ;
            };
            Promise.prototype._captureStackTrace = function() {};
            Promise.prototype._attachExtraTrace = function() {};
            Promise.prototype._clearCancellationData = function() {};
            Promise.prototype._propagateFrom = function(parent, flags) {
              ;
              ;
            };
            function cancellationExecute(executor, resolve, reject) {
              var promise = this;
              try {
                executor(resolve, reject, function(onCancel) {
                  if (typeof onCancel !== "function") {
                    throw new TypeError("onCancel must be a function, got: " + util.toString(onCancel));
                  }
                  promise._attachCancellationCallback(onCancel);
                });
              } catch (e) {
                return e;
              }
            }
            function cancellationAttachCancellationCallback(onCancel) {
              if (!this.isCancellable())
                return this;
              var previousOnCancel = this._onCancel();
              if (previousOnCancel !== undefined) {
                if (util.isArray(previousOnCancel)) {
                  previousOnCancel.push(onCancel);
                } else {
                  this._setOnCancel([previousOnCancel, onCancel]);
                }
              } else {
                this._setOnCancel(onCancel);
              }
            }
            function cancellationOnCancel() {
              return this._onCancelField;
            }
            function cancellationSetOnCancel(onCancel) {
              this._onCancelField = onCancel;
            }
            function cancellationClearCancellationData() {
              this._cancellationParent = undefined;
              this._onCancelField = undefined;
            }
            function cancellationPropagateFrom(parent, flags) {
              if ((flags & 1) !== 0) {
                this._cancellationParent = parent;
                var branchesRemainingToCancel = parent._branchesRemainingToCancel;
                if (branchesRemainingToCancel === undefined) {
                  branchesRemainingToCancel = 0;
                }
                parent._branchesRemainingToCancel = branchesRemainingToCancel + 1;
              }
              if ((flags & 2) !== 0 && parent._isBound()) {
                this._setBoundTo(parent._boundTo);
              }
            }
            function bindingPropagateFrom(parent, flags) {
              if ((flags & 2) !== 0 && parent._isBound()) {
                this._setBoundTo(parent._boundTo);
              }
            }
            var propagateFromFunction = bindingPropagateFrom;
            function boundValueFunction() {
              var ret = this._boundTo;
              if (ret !== undefined) {
                if (ret instanceof Promise) {
                  if (ret.isFulfilled()) {
                    return ret.value();
                  } else {
                    return undefined;
                  }
                }
              }
              return ret;
            }
            function longStackTracesCaptureStackTrace() {
              this._trace = new CapturedTrace(this._peekContext());
            }
            function longStackTracesAttachExtraTrace(error, ignoreSelf) {
              if (canAttachTrace(error)) {
                var trace = this._trace;
                if (trace !== undefined) {
                  if (ignoreSelf)
                    trace = trace._parent;
                }
                if (trace !== undefined) {
                  trace.attachExtraTrace(error);
                } else if (!error.__stackCleaned__) {
                  var parsed = parseStackAndMessage(error);
                  util.notEnumerableProp(error, "stack", parsed.message + "\n" + parsed.stack.join("\n"));
                  util.notEnumerableProp(error, "__stackCleaned__", true);
                }
              }
            }
            function checkForgottenReturns(returnValue, promiseCreated, name, promise, parent) {
              if (returnValue === undefined && promiseCreated !== null && wForgottenReturn) {
                if (parent !== undefined && parent._returnedNonUndefined())
                  return;
                if (name)
                  name = name + " ";
                var msg = "a promise was created in a " + name + "handler but was not returned from it";
                promise._warn(msg, true, promiseCreated);
              }
            }
            function deprecated(name, replacement) {
              var message = name + " is deprecated and will be removed in a future version.";
              if (replacement)
                message += " Use " + replacement + " instead.";
              return warn(message);
            }
            function warn(message, shouldUseOwnTrace, promise) {
              if (!config.warnings)
                return;
              var warning = new Warning(message);
              var ctx;
              if (shouldUseOwnTrace) {
                promise._attachExtraTrace(warning);
              } else if (config.longStackTraces && (ctx = Promise._peekContext())) {
                ctx.attachExtraTrace(warning);
              } else {
                var parsed = parseStackAndMessage(warning);
                warning.stack = parsed.message + "\n" + parsed.stack.join("\n");
              }
              formatAndLogError(warning, "", true);
            }
            function reconstructStack(message, stacks) {
              for (var i = 0; i < stacks.length - 1; ++i) {
                stacks[i].push("From previous event:");
                stacks[i] = stacks[i].join("\n");
              }
              if (i < stacks.length) {
                stacks[i] = stacks[i].join("\n");
              }
              return message + "\n" + stacks.join("\n");
            }
            function removeDuplicateOrEmptyJumps(stacks) {
              for (var i = 0; i < stacks.length; ++i) {
                if (stacks[i].length === 0 || ((i + 1 < stacks.length) && stacks[i][0] === stacks[i + 1][0])) {
                  stacks.splice(i, 1);
                  i--;
                }
              }
            }
            function removeCommonRoots(stacks) {
              var current = stacks[0];
              for (var i = 1; i < stacks.length; ++i) {
                var prev = stacks[i];
                var currentLastIndex = current.length - 1;
                var currentLastLine = current[currentLastIndex];
                var commonRootMeetPoint = -1;
                for (var j = prev.length - 1; j >= 0; --j) {
                  if (prev[j] === currentLastLine) {
                    commonRootMeetPoint = j;
                    break;
                  }
                }
                for (var j = commonRootMeetPoint; j >= 0; --j) {
                  var line = prev[j];
                  if (current[currentLastIndex] === line) {
                    current.pop();
                    currentLastIndex--;
                  } else {
                    break;
                  }
                }
                current = prev;
              }
            }
            function cleanStack(stack) {
              var ret = [];
              for (var i = 0; i < stack.length; ++i) {
                var line = stack[i];
                var isTraceLine = "    (No stack trace)" === line || stackFramePattern.test(line);
                var isInternalFrame = isTraceLine && shouldIgnore(line);
                if (isTraceLine && !isInternalFrame) {
                  if (indentStackFrames && line.charAt(0) !== " ") {
                    line = "    " + line;
                  }
                  ret.push(line);
                }
              }
              return ret;
            }
            function stackFramesAsArray(error) {
              var stack = error.stack.replace(/\s+$/g, "").split("\n");
              for (var i = 0; i < stack.length; ++i) {
                var line = stack[i];
                if ("    (No stack trace)" === line || stackFramePattern.test(line)) {
                  break;
                }
              }
              if (i > 0) {
                stack = stack.slice(i);
              }
              return stack;
            }
            function parseStackAndMessage(error) {
              var stack = error.stack;
              var message = error.toString();
              stack = typeof stack === "string" && stack.length > 0 ? stackFramesAsArray(error) : ["    (No stack trace)"];
              return {
                message: message,
                stack: cleanStack(stack)
              };
            }
            function formatAndLogError(error, title, isSoft) {
              if (typeof console !== "undefined") {
                var message;
                if (util.isObject(error)) {
                  var stack = error.stack;
                  message = title + formatStack(stack, error);
                } else {
                  message = title + String(error);
                }
                if (typeof printWarning === "function") {
                  printWarning(message, isSoft);
                } else if (typeof console.log === "function" || typeof console.log === "object") {
                  console.log(message);
                }
              }
            }
            function fireRejectionEvent(name, localHandler, reason, promise) {
              var localEventFired = false;
              try {
                if (typeof localHandler === "function") {
                  localEventFired = true;
                  if (name === "rejectionHandled") {
                    localHandler(promise);
                  } else {
                    localHandler(reason, promise);
                  }
                }
              } catch (e) {
                async.throwLater(e);
              }
              var globalEventFired = false;
              try {
                globalEventFired = fireGlobalEvent(name, reason, promise);
              } catch (e) {
                globalEventFired = true;
                async.throwLater(e);
              }
              var domEventFired = false;
              if (fireDomEvent) {
                try {
                  domEventFired = fireDomEvent(name.toLowerCase(), {
                    reason: reason,
                    promise: promise
                  });
                } catch (e) {
                  domEventFired = true;
                  async.throwLater(e);
                }
              }
              if (!globalEventFired && !localEventFired && !domEventFired && name === "unhandledRejection") {
                formatAndLogError(reason, "Unhandled rejection ");
              }
            }
            function formatNonError(obj) {
              var str;
              if (typeof obj === "function") {
                str = "[function " + (obj.name || "anonymous") + "]";
              } else {
                str = obj && typeof obj.toString === "function" ? obj.toString() : util.toString(obj);
                var ruselessToString = /\[object [a-zA-Z0-9$_]+\]/;
                if (ruselessToString.test(str)) {
                  try {
                    var newStr = JSON.stringify(obj);
                    str = newStr;
                  } catch (e) {}
                }
                if (str.length === 0) {
                  str = "(empty array)";
                }
              }
              return ("(<" + snip(str) + ">, no stack trace)");
            }
            function snip(str) {
              var maxChars = 41;
              if (str.length < maxChars) {
                return str;
              }
              return str.substr(0, maxChars - 3) + "...";
            }
            function longStackTracesIsSupported() {
              return typeof captureStackTrace === "function";
            }
            var shouldIgnore = function() {
              return false;
            };
            var parseLineInfoRegex = /[\/<\(]([^:\/]+):(\d+):(?:\d+)\)?\s*$/;
            function parseLineInfo(line) {
              var matches = line.match(parseLineInfoRegex);
              if (matches) {
                return {
                  fileName: matches[1],
                  line: parseInt(matches[2], 10)
                };
              }
            }
            function setBounds(firstLineError, lastLineError) {
              if (!longStackTracesIsSupported())
                return;
              var firstStackLines = firstLineError.stack.split("\n");
              var lastStackLines = lastLineError.stack.split("\n");
              var firstIndex = -1;
              var lastIndex = -1;
              var firstFileName;
              var lastFileName;
              for (var i = 0; i < firstStackLines.length; ++i) {
                var result = parseLineInfo(firstStackLines[i]);
                if (result) {
                  firstFileName = result.fileName;
                  firstIndex = result.line;
                  break;
                }
              }
              for (var i = 0; i < lastStackLines.length; ++i) {
                var result = parseLineInfo(lastStackLines[i]);
                if (result) {
                  lastFileName = result.fileName;
                  lastIndex = result.line;
                  break;
                }
              }
              if (firstIndex < 0 || lastIndex < 0 || !firstFileName || !lastFileName || firstFileName !== lastFileName || firstIndex >= lastIndex) {
                return;
              }
              shouldIgnore = function(line) {
                if (bluebirdFramePattern.test(line))
                  return true;
                var info = parseLineInfo(line);
                if (info) {
                  if (info.fileName === firstFileName && (firstIndex <= info.line && info.line <= lastIndex)) {
                    return true;
                  }
                }
                return false;
              };
            }
            function CapturedTrace(parent) {
              this._parent = parent;
              this._promisesCreated = 0;
              var length = this._length = 1 + (parent === undefined ? 0 : parent._length);
              captureStackTrace(this, CapturedTrace);
              if (length > 32)
                this.uncycle();
            }
            util.inherits(CapturedTrace, Error);
            Context.CapturedTrace = CapturedTrace;
            CapturedTrace.prototype.uncycle = function() {
              var length = this._length;
              if (length < 2)
                return;
              var nodes = [];
              var stackToIndex = {};
              for (var i = 0,
                  node = this; node !== undefined; ++i) {
                nodes.push(node);
                node = node._parent;
              }
              length = this._length = i;
              for (var i = length - 1; i >= 0; --i) {
                var stack = nodes[i].stack;
                if (stackToIndex[stack] === undefined) {
                  stackToIndex[stack] = i;
                }
              }
              for (var i = 0; i < length; ++i) {
                var currentStack = nodes[i].stack;
                var index = stackToIndex[currentStack];
                if (index !== undefined && index !== i) {
                  if (index > 0) {
                    nodes[index - 1]._parent = undefined;
                    nodes[index - 1]._length = 1;
                  }
                  nodes[i]._parent = undefined;
                  nodes[i]._length = 1;
                  var cycleEdgeNode = i > 0 ? nodes[i - 1] : this;
                  if (index < length - 1) {
                    cycleEdgeNode._parent = nodes[index + 1];
                    cycleEdgeNode._parent.uncycle();
                    cycleEdgeNode._length = cycleEdgeNode._parent._length + 1;
                  } else {
                    cycleEdgeNode._parent = undefined;
                    cycleEdgeNode._length = 1;
                  }
                  var currentChildLength = cycleEdgeNode._length + 1;
                  for (var j = i - 2; j >= 0; --j) {
                    nodes[j]._length = currentChildLength;
                    currentChildLength++;
                  }
                  return;
                }
              }
            };
            CapturedTrace.prototype.attachExtraTrace = function(error) {
              if (error.__stackCleaned__)
                return;
              this.uncycle();
              var parsed = parseStackAndMessage(error);
              var message = parsed.message;
              var stacks = [parsed.stack];
              var trace = this;
              while (trace !== undefined) {
                stacks.push(cleanStack(trace.stack.split("\n")));
                trace = trace._parent;
              }
              removeCommonRoots(stacks);
              removeDuplicateOrEmptyJumps(stacks);
              util.notEnumerableProp(error, "stack", reconstructStack(message, stacks));
              util.notEnumerableProp(error, "__stackCleaned__", true);
            };
            var captureStackTrace = (function stackDetection() {
              var v8stackFramePattern = /^\s*at\s*/;
              var v8stackFormatter = function(stack, error) {
                if (typeof stack === "string")
                  return stack;
                if (error.name !== undefined && error.message !== undefined) {
                  return error.toString();
                }
                return formatNonError(error);
              };
              if (typeof Error.stackTraceLimit === "number" && typeof Error.captureStackTrace === "function") {
                Error.stackTraceLimit += 6;
                stackFramePattern = v8stackFramePattern;
                formatStack = v8stackFormatter;
                var captureStackTrace = Error.captureStackTrace;
                shouldIgnore = function(line) {
                  return bluebirdFramePattern.test(line);
                };
                return function(receiver, ignoreUntil) {
                  Error.stackTraceLimit += 6;
                  captureStackTrace(receiver, ignoreUntil);
                  Error.stackTraceLimit -= 6;
                };
              }
              var err = new Error();
              if (typeof err.stack === "string" && err.stack.split("\n")[0].indexOf("stackDetection@") >= 0) {
                stackFramePattern = /@/;
                formatStack = v8stackFormatter;
                indentStackFrames = true;
                return function captureStackTrace(o) {
                  o.stack = new Error().stack;
                };
              }
              var hasStackAfterThrow;
              try {
                throw new Error();
              } catch (e) {
                hasStackAfterThrow = ("stack" in e);
              }
              if (!("stack" in err) && hasStackAfterThrow && typeof Error.stackTraceLimit === "number") {
                stackFramePattern = v8stackFramePattern;
                formatStack = v8stackFormatter;
                return function captureStackTrace(o) {
                  Error.stackTraceLimit += 6;
                  try {
                    throw new Error();
                  } catch (e) {
                    o.stack = e.stack;
                  }
                  Error.stackTraceLimit -= 6;
                };
              }
              formatStack = function(stack, error) {
                if (typeof stack === "string")
                  return stack;
                if ((typeof error === "object" || typeof error === "function") && error.name !== undefined && error.message !== undefined) {
                  return error.toString();
                }
                return formatNonError(error);
              };
              return null;
            })([]);
            var fireDomEvent;
            var fireGlobalEvent = (function() {
              if (util.isNode) {
                return function(name, reason, promise) {
                  if (name === "rejectionHandled") {
                    return process.emit(name, promise);
                  } else {
                    return process.emit(name, reason, promise);
                  }
                };
              } else {
                var globalObject = typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : typeof global !== "undefined" ? global : this !== undefined ? this : null;
                if (!globalObject) {
                  return function() {
                    return false;
                  };
                }
                try {
                  var event = document.createEvent("CustomEvent");
                  event.initCustomEvent("testingtheevent", false, true, {});
                  globalObject.dispatchEvent(event);
                  fireDomEvent = function(type, detail) {
                    var event = document.createEvent("CustomEvent");
                    event.initCustomEvent(type, false, true, detail);
                    return !globalObject.dispatchEvent(event);
                  };
                } catch (e) {}
                var toWindowMethodNameMap = {};
                toWindowMethodNameMap["unhandledRejection"] = ("on" + "unhandledRejection").toLowerCase();
                toWindowMethodNameMap["rejectionHandled"] = ("on" + "rejectionHandled").toLowerCase();
                return function(name, reason, promise) {
                  var methodName = toWindowMethodNameMap[name];
                  var method = globalObject[methodName];
                  if (!method)
                    return false;
                  if (name === "rejectionHandled") {
                    method.call(globalObject, promise);
                  } else {
                    method.call(globalObject, reason, promise);
                  }
                  return true;
                };
              }
            })();
            if (typeof console !== "undefined" && typeof console.warn !== "undefined") {
              printWarning = function(message) {
                console.warn(message);
              };
              if (util.isNode && process.stderr.isTTY) {
                printWarning = function(message, isSoft) {
                  var color = isSoft ? "\u001b[33m" : "\u001b[31m";
                  console.warn(color + message + "\u001b[0m\n");
                };
              } else if (!util.isNode && typeof(new Error().stack) === "string") {
                printWarning = function(message, isSoft) {
                  console.warn("%c" + message, isSoft ? "color: darkorange" : "color: red");
                };
              }
            }
            var config = {
              warnings: warnings,
              longStackTraces: false,
              cancellation: false
            };
            if (longStackTraces)
              Promise.longStackTraces();
            return {
              longStackTraces: function() {
                return config.longStackTraces;
              },
              warnings: function() {
                return config.warnings;
              },
              cancellation: function() {
                return config.cancellation;
              },
              propagateFromFunction: function() {
                return propagateFromFunction;
              },
              boundValueFunction: function() {
                return boundValueFunction;
              },
              checkForgottenReturns: checkForgottenReturns,
              setBounds: setBounds,
              warn: warn,
              deprecated: deprecated,
              CapturedTrace: CapturedTrace
            };
          };
        }, {
          "./errors": 12,
          "./util": 36
        }],
        10: [function(_dereq_, module, exports) {
          "use strict";
          module.exports = function(Promise) {
            function returner() {
              return this.value;
            }
            function thrower() {
              throw this.reason;
            }
            Promise.prototype["return"] = Promise.prototype.thenReturn = function(value) {
              if (value instanceof Promise)
                value.suppressUnhandledRejections();
              return this._then(returner, undefined, undefined, {value: value}, undefined);
            };
            Promise.prototype["throw"] = Promise.prototype.thenThrow = function(reason) {
              return this._then(thrower, undefined, undefined, {reason: reason}, undefined);
            };
            Promise.prototype.catchThrow = function(reason) {
              if (arguments.length <= 1) {
                return this._then(undefined, thrower, undefined, {reason: reason}, undefined);
              } else {
                var _reason = arguments[1];
                var handler = function() {
                  throw _reason;
                };
                return this.caught(reason, handler);
              }
            };
            Promise.prototype.catchReturn = function(value) {
              if (arguments.length <= 1) {
                if (value instanceof Promise)
                  value.suppressUnhandledRejections();
                return this._then(undefined, returner, undefined, {value: value}, undefined);
              } else {
                var _value = arguments[1];
                if (_value instanceof Promise)
                  _value.suppressUnhandledRejections();
                var handler = function() {
                  return _value;
                };
                return this.caught(value, handler);
              }
            };
          };
        }, {}],
        11: [function(_dereq_, module, exports) {
          "use strict";
          module.exports = function(Promise, INTERNAL) {
            var PromiseReduce = Promise.reduce;
            var PromiseAll = Promise.all;
            function promiseAllThis() {
              return PromiseAll(this);
            }
            function PromiseMapSeries(promises, fn) {
              return PromiseReduce(promises, fn, INTERNAL, INTERNAL);
            }
            Promise.prototype.each = function(fn) {
              return this.mapSeries(fn)._then(promiseAllThis, undefined, undefined, this, undefined);
            };
            Promise.prototype.mapSeries = function(fn) {
              return PromiseReduce(this, fn, INTERNAL, INTERNAL);
            };
            Promise.each = function(promises, fn) {
              return PromiseMapSeries(promises, fn)._then(promiseAllThis, undefined, undefined, promises, undefined);
            };
            Promise.mapSeries = PromiseMapSeries;
          };
        }, {}],
        12: [function(_dereq_, module, exports) {
          "use strict";
          var es5 = _dereq_("./es5");
          var Objectfreeze = es5.freeze;
          var util = _dereq_("./util");
          var inherits = util.inherits;
          var notEnumerableProp = util.notEnumerableProp;
          function subError(nameProperty, defaultMessage) {
            function SubError(message) {
              if (!(this instanceof SubError))
                return new SubError(message);
              notEnumerableProp(this, "message", typeof message === "string" ? message : defaultMessage);
              notEnumerableProp(this, "name", nameProperty);
              if (Error.captureStackTrace) {
                Error.captureStackTrace(this, this.constructor);
              } else {
                Error.call(this);
              }
            }
            inherits(SubError, Error);
            return SubError;
          }
          var _TypeError,
              _RangeError;
          var Warning = subError("Warning", "warning");
          var CancellationError = subError("CancellationError", "cancellation error");
          var TimeoutError = subError("TimeoutError", "timeout error");
          var AggregateError = subError("AggregateError", "aggregate error");
          try {
            _TypeError = TypeError;
            _RangeError = RangeError;
          } catch (e) {
            _TypeError = subError("TypeError", "type error");
            _RangeError = subError("RangeError", "range error");
          }
          var methods = ("join pop push shift unshift slice filter forEach some " + "every map indexOf lastIndexOf reduce reduceRight sort reverse").split(" ");
          for (var i = 0; i < methods.length; ++i) {
            if (typeof Array.prototype[methods[i]] === "function") {
              AggregateError.prototype[methods[i]] = Array.prototype[methods[i]];
            }
          }
          es5.defineProperty(AggregateError.prototype, "length", {
            value: 0,
            configurable: false,
            writable: true,
            enumerable: true
          });
          AggregateError.prototype["isOperational"] = true;
          var level = 0;
          AggregateError.prototype.toString = function() {
            var indent = Array(level * 4 + 1).join(" ");
            var ret = "\n" + indent + "AggregateError of:" + "\n";
            level++;
            indent = Array(level * 4 + 1).join(" ");
            for (var i = 0; i < this.length; ++i) {
              var str = this[i] === this ? "[Circular AggregateError]" : this[i] + "";
              var lines = str.split("\n");
              for (var j = 0; j < lines.length; ++j) {
                lines[j] = indent + lines[j];
              }
              str = lines.join("\n");
              ret += str + "\n";
            }
            level--;
            return ret;
          };
          function OperationalError(message) {
            if (!(this instanceof OperationalError))
              return new OperationalError(message);
            notEnumerableProp(this, "name", "OperationalError");
            notEnumerableProp(this, "message", message);
            this.cause = message;
            this["isOperational"] = true;
            if (message instanceof Error) {
              notEnumerableProp(this, "message", message.message);
              notEnumerableProp(this, "stack", message.stack);
            } else if (Error.captureStackTrace) {
              Error.captureStackTrace(this, this.constructor);
            }
          }
          inherits(OperationalError, Error);
          var errorTypes = Error["__BluebirdErrorTypes__"];
          if (!errorTypes) {
            errorTypes = Objectfreeze({
              CancellationError: CancellationError,
              TimeoutError: TimeoutError,
              OperationalError: OperationalError,
              RejectionError: OperationalError,
              AggregateError: AggregateError
            });
            notEnumerableProp(Error, "__BluebirdErrorTypes__", errorTypes);
          }
          module.exports = {
            Error: Error,
            TypeError: _TypeError,
            RangeError: _RangeError,
            CancellationError: errorTypes.CancellationError,
            OperationalError: errorTypes.OperationalError,
            TimeoutError: errorTypes.TimeoutError,
            AggregateError: errorTypes.AggregateError,
            Warning: Warning
          };
        }, {
          "./es5": 13,
          "./util": 36
        }],
        13: [function(_dereq_, module, exports) {
          var isES5 = (function() {
            "use strict";
            return this === undefined;
          })();
          if (isES5) {
            module.exports = {
              freeze: Object.freeze,
              defineProperty: Object.defineProperty,
              getDescriptor: Object.getOwnPropertyDescriptor,
              keys: Object.keys,
              names: Object.getOwnPropertyNames,
              getPrototypeOf: Object.getPrototypeOf,
              isArray: Array.isArray,
              isES5: isES5,
              propertyIsWritable: function(obj, prop) {
                var descriptor = Object.getOwnPropertyDescriptor(obj, prop);
                return !!(!descriptor || descriptor.writable || descriptor.set);
              }
            };
          } else {
            var has = {}.hasOwnProperty;
            var str = {}.toString;
            var proto = {}.constructor.prototype;
            var ObjectKeys = function(o) {
              var ret = [];
              for (var key in o) {
                if (has.call(o, key)) {
                  ret.push(key);
                }
              }
              return ret;
            };
            var ObjectGetDescriptor = function(o, key) {
              return {value: o[key]};
            };
            var ObjectDefineProperty = function(o, key, desc) {
              o[key] = desc.value;
              return o;
            };
            var ObjectFreeze = function(obj) {
              return obj;
            };
            var ObjectGetPrototypeOf = function(obj) {
              try {
                return Object(obj).constructor.prototype;
              } catch (e) {
                return proto;
              }
            };
            var ArrayIsArray = function(obj) {
              try {
                return str.call(obj) === "[object Array]";
              } catch (e) {
                return false;
              }
            };
            module.exports = {
              isArray: ArrayIsArray,
              keys: ObjectKeys,
              names: ObjectKeys,
              defineProperty: ObjectDefineProperty,
              getDescriptor: ObjectGetDescriptor,
              freeze: ObjectFreeze,
              getPrototypeOf: ObjectGetPrototypeOf,
              isES5: isES5,
              propertyIsWritable: function() {
                return true;
              }
            };
          }
        }, {}],
        14: [function(_dereq_, module, exports) {
          "use strict";
          module.exports = function(Promise, INTERNAL) {
            var PromiseMap = Promise.map;
            Promise.prototype.filter = function(fn, options) {
              return PromiseMap(this, fn, options, INTERNAL);
            };
            Promise.filter = function(promises, fn, options) {
              return PromiseMap(promises, fn, options, INTERNAL);
            };
          };
        }, {}],
        15: [function(_dereq_, module, exports) {
          "use strict";
          module.exports = function(Promise, tryConvertToPromise) {
            var util = _dereq_("./util");
            var CancellationError = Promise.CancellationError;
            var errorObj = util.errorObj;
            function FinallyHandlerCancelReaction(finallyHandler) {
              this.finallyHandler = finallyHandler;
            }
            FinallyHandlerCancelReaction.prototype._resultCancelled = function() {
              checkCancel(this.finallyHandler);
            };
            function checkCancel(ctx, reason) {
              if (ctx.cancelPromise != null) {
                if (arguments.length > 1) {
                  ctx.cancelPromise._reject(reason);
                } else {
                  ctx.cancelPromise._cancel();
                }
                ctx.cancelPromise = null;
                return true;
              }
              return false;
            }
            function succeed() {
              return finallyHandler.call(this, this.promise._target()._settledValue());
            }
            function fail(reason) {
              if (checkCancel(this, reason))
                return;
              errorObj.e = reason;
              return errorObj;
            }
            function finallyHandler(reasonOrValue) {
              var promise = this.promise;
              var handler = this.handler;
              if (!this.called) {
                this.called = true;
                var ret = this.type === 0 ? handler.call(promise._boundValue()) : handler.call(promise._boundValue(), reasonOrValue);
                if (ret !== undefined) {
                  promise._setReturnedNonUndefined();
                  var maybePromise = tryConvertToPromise(ret, promise);
                  if (maybePromise instanceof Promise) {
                    if (this.cancelPromise != null) {
                      if (maybePromise.isCancelled()) {
                        var reason = new CancellationError("late cancellation observer");
                        promise._attachExtraTrace(reason);
                        errorObj.e = reason;
                        return errorObj;
                      } else if (maybePromise.isPending()) {
                        maybePromise._attachCancellationCallback(new FinallyHandlerCancelReaction(this));
                      }
                    }
                    return maybePromise._then(succeed, fail, undefined, this, undefined);
                  }
                }
              }
              if (promise.isRejected()) {
                checkCancel(this);
                errorObj.e = reasonOrValue;
                return errorObj;
              } else {
                checkCancel(this);
                return reasonOrValue;
              }
            }
            Promise.prototype._passThrough = function(handler, type, success, fail) {
              if (typeof handler !== "function")
                return this.then();
              return this._then(success, fail, undefined, {
                promise: this,
                handler: handler,
                called: false,
                cancelPromise: null,
                type: type
              }, undefined);
            };
            Promise.prototype.lastly = Promise.prototype["finally"] = function(handler) {
              return this._passThrough(handler, 0, finallyHandler, finallyHandler);
            };
            Promise.prototype.tap = function(handler) {
              return this._passThrough(handler, 1, finallyHandler);
            };
            return finallyHandler;
          };
        }, {"./util": 36}],
        16: [function(_dereq_, module, exports) {
          "use strict";
          module.exports = function(Promise, apiRejection, INTERNAL, tryConvertToPromise, Proxyable, debug) {
            var errors = _dereq_("./errors");
            var TypeError = errors.TypeError;
            var util = _dereq_("./util");
            var errorObj = util.errorObj;
            var tryCatch = util.tryCatch;
            var yieldHandlers = [];
            function promiseFromYieldHandler(value, yieldHandlers, traceParent) {
              for (var i = 0; i < yieldHandlers.length; ++i) {
                traceParent._pushContext();
                var result = tryCatch(yieldHandlers[i])(value);
                traceParent._popContext();
                if (result === errorObj) {
                  traceParent._pushContext();
                  var ret = Promise.reject(errorObj.e);
                  traceParent._popContext();
                  return ret;
                }
                var maybePromise = tryConvertToPromise(result, traceParent);
                if (maybePromise instanceof Promise)
                  return maybePromise;
              }
              return null;
            }
            function PromiseSpawn(generatorFunction, receiver, yieldHandler, stack) {
              var promise = this._promise = new Promise(INTERNAL);
              promise._captureStackTrace();
              promise._setOnCancel(this);
              this._stack = stack;
              this._generatorFunction = generatorFunction;
              this._receiver = receiver;
              this._generator = undefined;
              this._yieldHandlers = typeof yieldHandler === "function" ? [yieldHandler].concat(yieldHandlers) : yieldHandlers;
              this._yieldedPromise = null;
            }
            util.inherits(PromiseSpawn, Proxyable);
            PromiseSpawn.prototype._isResolved = function() {
              return this._promise === null;
            };
            PromiseSpawn.prototype._cleanup = function() {
              this._promise = this._generator = null;
            };
            PromiseSpawn.prototype._promiseCancelled = function() {
              if (this._isResolved())
                return;
              var implementsReturn = typeof this._generator["return"] !== "undefined";
              var result;
              if (!implementsReturn) {
                var reason = new Promise.CancellationError("generator .return() sentinel");
                Promise.coroutine.returnSentinel = reason;
                this._promise._attachExtraTrace(reason);
                this._promise._pushContext();
                result = tryCatch(this._generator["throw"]).call(this._generator, reason);
                this._promise._popContext();
                if (result === errorObj && result.e === reason) {
                  result = null;
                }
              } else {
                this._promise._pushContext();
                result = tryCatch(this._generator["return"]).call(this._generator, undefined);
                this._promise._popContext();
              }
              var promise = this._promise;
              this._cleanup();
              if (result === errorObj) {
                promise._rejectCallback(result.e, false);
              } else {
                promise.cancel();
              }
            };
            PromiseSpawn.prototype._promiseFulfilled = function(value) {
              this._yieldedPromise = null;
              this._promise._pushContext();
              var result = tryCatch(this._generator.next).call(this._generator, value);
              this._promise._popContext();
              this._continue(result);
            };
            PromiseSpawn.prototype._promiseRejected = function(reason) {
              this._yieldedPromise = null;
              this._promise._attachExtraTrace(reason);
              this._promise._pushContext();
              var result = tryCatch(this._generator["throw"]).call(this._generator, reason);
              this._promise._popContext();
              this._continue(result);
            };
            PromiseSpawn.prototype._resultCancelled = function() {
              if (this._yieldedPromise instanceof Promise) {
                var promise = this._yieldedPromise;
                this._yieldedPromise = null;
                promise.cancel();
              }
            };
            PromiseSpawn.prototype.promise = function() {
              return this._promise;
            };
            PromiseSpawn.prototype._run = function() {
              this._generator = this._generatorFunction.call(this._receiver);
              this._receiver = this._generatorFunction = undefined;
              this._promiseFulfilled(undefined);
            };
            PromiseSpawn.prototype._continue = function(result) {
              var promise = this._promise;
              if (result === errorObj) {
                this._cleanup();
                return promise._rejectCallback(result.e, false);
              }
              var value = result.value;
              if (result.done === true) {
                this._cleanup();
                return promise._resolveCallback(value);
              } else {
                var maybePromise = tryConvertToPromise(value, this._promise);
                if (!(maybePromise instanceof Promise)) {
                  maybePromise = promiseFromYieldHandler(maybePromise, this._yieldHandlers, this._promise);
                  if (maybePromise === null) {
                    this._promiseRejected(new TypeError("A value %s was yielded that could not be treated as a promise\u000a\u000a    See http://goo.gl/MqrFmX\u000a\u000a".replace("%s", value) + "From coroutine:\u000a" + this._stack.split("\n").slice(1, -7).join("\n")));
                    return;
                  }
                }
                maybePromise = maybePromise._target();
                var bitField = maybePromise._bitField;
                ;
                if (((bitField & 50397184) === 0)) {
                  this._yieldedPromise = maybePromise;
                  maybePromise._proxy(this, null);
                } else if (((bitField & 33554432) !== 0)) {
                  this._promiseFulfilled(maybePromise._value());
                } else if (((bitField & 16777216) !== 0)) {
                  this._promiseRejected(maybePromise._reason());
                } else {
                  this._promiseCancelled();
                }
              }
            };
            Promise.coroutine = function(generatorFunction, options) {
              if (typeof generatorFunction !== "function") {
                throw new TypeError("generatorFunction must be a function\u000a\u000a    See http://goo.gl/MqrFmX\u000a");
              }
              var yieldHandler = Object(options).yieldHandler;
              var PromiseSpawn$ = PromiseSpawn;
              var stack = new Error().stack;
              return function() {
                var generator = generatorFunction.apply(this, arguments);
                var spawn = new PromiseSpawn$(undefined, undefined, yieldHandler, stack);
                var ret = spawn.promise();
                spawn._generator = generator;
                spawn._promiseFulfilled(undefined);
                return ret;
              };
            };
            Promise.coroutine.addYieldHandler = function(fn) {
              if (typeof fn !== "function") {
                throw new TypeError("expecting a function but got " + util.classString(fn));
              }
              yieldHandlers.push(fn);
            };
            Promise.spawn = function(generatorFunction) {
              debug.deprecated("Promise.spawn()", "Promise.coroutine()");
              if (typeof generatorFunction !== "function") {
                return apiRejection("generatorFunction must be a function\u000a\u000a    See http://goo.gl/MqrFmX\u000a");
              }
              var spawn = new PromiseSpawn(generatorFunction, this);
              var ret = spawn.promise();
              spawn._run(Promise.spawn);
              return ret;
            };
          };
        }, {
          "./errors": 12,
          "./util": 36
        }],
        17: [function(_dereq_, module, exports) {
          "use strict";
          module.exports = function(Promise, PromiseArray, tryConvertToPromise, INTERNAL) {
            var util = _dereq_("./util");
            var canEvaluate = util.canEvaluate;
            var tryCatch = util.tryCatch;
            var errorObj = util.errorObj;
            var reject;
            if (!true) {
              if (canEvaluate) {
                var thenCallback = function(i) {
                  return new Function("value", "holder", "                             \n\
            'use strict';                                                    \n\
            holder.pIndex = value;                                           \n\
            holder.checkFulfillment(this);                                   \n\
            ".replace(/Index/g, i));
                };
                var promiseSetter = function(i) {
                  return new Function("promise", "holder", "                           \n\
            'use strict';                                                    \n\
            holder.pIndex = promise;                                         \n\
            ".replace(/Index/g, i));
                };
                var generateHolderClass = function(total) {
                  var props = new Array(total);
                  for (var i = 0; i < props.length; ++i) {
                    props[i] = "this.p" + (i + 1);
                  }
                  var assignment = props.join(" = ") + " = null;";
                  var cancellationCode = "var promise;\n" + props.map(function(prop) {
                    return "                                                         \n\
                promise = " + prop + ";                                      \n\
                if (promise instanceof Promise) {                            \n\
                    promise.cancel();                                        \n\
                }                                                            \n\
            ";
                  }).join("\n");
                  var passedArguments = props.join(", ");
                  var name = "Holder$" + total;
                  var code = "return function(tryCatch, errorObj, Promise) {           \n\
            'use strict';                                                    \n\
            function [TheName](fn) {                                         \n\
                [TheProperties]                                              \n\
                this.fn = fn;                                                \n\
                this.now = 0;                                                \n\
            }                                                                \n\
            [TheName].prototype.checkFulfillment = function(promise) {       \n\
                var now = ++this.now;                                        \n\
                if (now === [TheTotal]) {                                    \n\
                    promise._pushContext();                                  \n\
                    var callback = this.fn;                                  \n\
                    var ret = tryCatch(callback)([ThePassedArguments]);      \n\
                    promise._popContext();                                   \n\
                    if (ret === errorObj) {                                  \n\
                        promise._rejectCallback(ret.e, false);               \n\
                    } else {                                                 \n\
                        promise._resolveCallback(ret);                       \n\
                    }                                                        \n\
                }                                                            \n\
            };                                                               \n\
                                                                             \n\
            [TheName].prototype._resultCancelled = function() {              \n\
                [CancellationCode]                                           \n\
            };                                                               \n\
                                                                             \n\
            return [TheName];                                                \n\
        }(tryCatch, errorObj, Promise);                                      \n\
        ";
                  code = code.replace(/\[TheName\]/g, name).replace(/\[TheTotal\]/g, total).replace(/\[ThePassedArguments\]/g, passedArguments).replace(/\[TheProperties\]/g, assignment).replace(/\[CancellationCode\]/g, cancellationCode);
                  return new Function("tryCatch", "errorObj", "Promise", code)(tryCatch, errorObj, Promise);
                };
                var holderClasses = [];
                var thenCallbacks = [];
                var promiseSetters = [];
                for (var i = 0; i < 8; ++i) {
                  holderClasses.push(generateHolderClass(i + 1));
                  thenCallbacks.push(thenCallback(i + 1));
                  promiseSetters.push(promiseSetter(i + 1));
                }
                reject = function(reason) {
                  this._reject(reason);
                };
              }
            }
            Promise.join = function() {
              var last = arguments.length - 1;
              var fn;
              if (last > 0 && typeof arguments[last] === "function") {
                fn = arguments[last];
                if (!true) {
                  if (last <= 8 && canEvaluate) {
                    var ret = new Promise(INTERNAL);
                    ret._captureStackTrace();
                    var HolderClass = holderClasses[last - 1];
                    var holder = new HolderClass(fn);
                    var callbacks = thenCallbacks;
                    for (var i = 0; i < last; ++i) {
                      var maybePromise = tryConvertToPromise(arguments[i], ret);
                      if (maybePromise instanceof Promise) {
                        maybePromise = maybePromise._target();
                        var bitField = maybePromise._bitField;
                        ;
                        if (((bitField & 50397184) === 0)) {
                          maybePromise._then(callbacks[i], reject, undefined, ret, holder);
                          promiseSetters[i](maybePromise, holder);
                        } else if (((bitField & 33554432) !== 0)) {
                          callbacks[i].call(ret, maybePromise._value(), holder);
                        } else if (((bitField & 16777216) !== 0)) {
                          ret._reject(maybePromise._reason());
                        } else {
                          ret._cancel();
                        }
                      } else {
                        callbacks[i].call(ret, maybePromise, holder);
                      }
                    }
                    if (!ret._isFateSealed()) {
                      ret._setAsyncGuaranteed();
                      ret._setOnCancel(holder);
                    }
                    return ret;
                  }
                }
              }
              var args = [].slice.call(arguments);
              ;
              if (fn)
                args.pop();
              var ret = new PromiseArray(args).promise();
              return fn !== undefined ? ret.spread(fn) : ret;
            };
          };
        }, {"./util": 36}],
        18: [function(_dereq_, module, exports) {
          "use strict";
          module.exports = function(Promise, PromiseArray, apiRejection, tryConvertToPromise, INTERNAL, debug) {
            var getDomain = Promise._getDomain;
            var util = _dereq_("./util");
            var tryCatch = util.tryCatch;
            var errorObj = util.errorObj;
            var EMPTY_ARRAY = [];
            function MappingPromiseArray(promises, fn, limit, _filter) {
              this.constructor$(promises);
              this._promise._captureStackTrace();
              var domain = getDomain();
              this._callback = domain === null ? fn : domain.bind(fn);
              this._preservedValues = _filter === INTERNAL ? new Array(this.length()) : null;
              this._limit = limit;
              this._inFlight = 0;
              this._queue = limit >= 1 ? [] : EMPTY_ARRAY;
              this._init$(undefined, -2);
            }
            util.inherits(MappingPromiseArray, PromiseArray);
            MappingPromiseArray.prototype._init = function() {};
            MappingPromiseArray.prototype._promiseFulfilled = function(value, index) {
              var values = this._values;
              var length = this.length();
              var preservedValues = this._preservedValues;
              var limit = this._limit;
              if (index < 0) {
                index = (index * -1) - 1;
                values[index] = value;
                if (limit >= 1) {
                  this._inFlight--;
                  this._drainQueue();
                  if (this._isResolved())
                    return true;
                }
              } else {
                if (limit >= 1 && this._inFlight >= limit) {
                  values[index] = value;
                  this._queue.push(index);
                  return false;
                }
                if (preservedValues !== null)
                  preservedValues[index] = value;
                var promise = this._promise;
                var callback = this._callback;
                var receiver = promise._boundValue();
                promise._pushContext();
                var ret = tryCatch(callback).call(receiver, value, index, length);
                var promiseCreated = promise._popContext();
                debug.checkForgottenReturns(ret, promiseCreated, preservedValues !== null ? "Promise.filter" : "Promise.map", promise);
                if (ret === errorObj) {
                  this._reject(ret.e);
                  return true;
                }
                var maybePromise = tryConvertToPromise(ret, this._promise);
                if (maybePromise instanceof Promise) {
                  maybePromise = maybePromise._target();
                  var bitField = maybePromise._bitField;
                  ;
                  if (((bitField & 50397184) === 0)) {
                    if (limit >= 1)
                      this._inFlight++;
                    values[index] = maybePromise;
                    maybePromise._proxy(this, (index + 1) * -1);
                    return false;
                  } else if (((bitField & 33554432) !== 0)) {
                    ret = maybePromise._value();
                  } else if (((bitField & 16777216) !== 0)) {
                    this._reject(maybePromise._reason());
                    return true;
                  } else {
                    this._cancel();
                    return true;
                  }
                }
                values[index] = ret;
              }
              var totalResolved = ++this._totalResolved;
              if (totalResolved >= length) {
                if (preservedValues !== null) {
                  this._filter(values, preservedValues);
                } else {
                  this._resolve(values);
                }
                return true;
              }
              return false;
            };
            MappingPromiseArray.prototype._drainQueue = function() {
              var queue = this._queue;
              var limit = this._limit;
              var values = this._values;
              while (queue.length > 0 && this._inFlight < limit) {
                if (this._isResolved())
                  return;
                var index = queue.pop();
                this._promiseFulfilled(values[index], index);
              }
            };
            MappingPromiseArray.prototype._filter = function(booleans, values) {
              var len = values.length;
              var ret = new Array(len);
              var j = 0;
              for (var i = 0; i < len; ++i) {
                if (booleans[i])
                  ret[j++] = values[i];
              }
              ret.length = j;
              this._resolve(ret);
            };
            MappingPromiseArray.prototype.preservedValues = function() {
              return this._preservedValues;
            };
            function map(promises, fn, options, _filter) {
              if (typeof fn !== "function") {
                return apiRejection("expecting a function but got " + util.classString(fn));
              }
              var limit = typeof options === "object" && options !== null ? options.concurrency : 0;
              limit = typeof limit === "number" && isFinite(limit) && limit >= 1 ? limit : 0;
              return new MappingPromiseArray(promises, fn, limit, _filter).promise();
            }
            Promise.prototype.map = function(fn, options) {
              return map(this, fn, options, null);
            };
            Promise.map = function(promises, fn, options, _filter) {
              return map(promises, fn, options, _filter);
            };
          };
        }, {"./util": 36}],
        19: [function(_dereq_, module, exports) {
          "use strict";
          module.exports = function(Promise, INTERNAL, tryConvertToPromise, apiRejection, debug) {
            var util = _dereq_("./util");
            var tryCatch = util.tryCatch;
            Promise.method = function(fn) {
              if (typeof fn !== "function") {
                throw new Promise.TypeError("expecting a function but got " + util.classString(fn));
              }
              return function() {
                var ret = new Promise(INTERNAL);
                ret._captureStackTrace();
                ret._pushContext();
                var value = tryCatch(fn).apply(this, arguments);
                var promiseCreated = ret._popContext();
                debug.checkForgottenReturns(value, promiseCreated, "Promise.method", ret);
                ret._resolveFromSyncValue(value);
                return ret;
              };
            };
            Promise.attempt = Promise["try"] = function(fn) {
              if (typeof fn !== "function") {
                return apiRejection("expecting a function but got " + util.classString(fn));
              }
              var ret = new Promise(INTERNAL);
              ret._captureStackTrace();
              ret._pushContext();
              var value;
              if (arguments.length > 1) {
                debug.deprecated("calling Promise.try with more than 1 argument");
                var arg = arguments[1];
                var ctx = arguments[2];
                value = util.isArray(arg) ? tryCatch(fn).apply(ctx, arg) : tryCatch(fn).call(ctx, arg);
              } else {
                value = tryCatch(fn)();
              }
              var promiseCreated = ret._popContext();
              debug.checkForgottenReturns(value, promiseCreated, "Promise.try", ret);
              ret._resolveFromSyncValue(value);
              return ret;
            };
            Promise.prototype._resolveFromSyncValue = function(value) {
              if (value === util.errorObj) {
                this._rejectCallback(value.e, false);
              } else {
                this._resolveCallback(value, true);
              }
            };
          };
        }, {"./util": 36}],
        20: [function(_dereq_, module, exports) {
          "use strict";
          var util = _dereq_("./util");
          var maybeWrapAsError = util.maybeWrapAsError;
          var errors = _dereq_("./errors");
          var OperationalError = errors.OperationalError;
          var es5 = _dereq_("./es5");
          function isUntypedError(obj) {
            return obj instanceof Error && es5.getPrototypeOf(obj) === Error.prototype;
          }
          var rErrorKey = /^(?:name|message|stack|cause)$/;
          function wrapAsOperationalError(obj) {
            var ret;
            if (isUntypedError(obj)) {
              ret = new OperationalError(obj);
              ret.name = obj.name;
              ret.message = obj.message;
              ret.stack = obj.stack;
              var keys = es5.keys(obj);
              for (var i = 0; i < keys.length; ++i) {
                var key = keys[i];
                if (!rErrorKey.test(key)) {
                  ret[key] = obj[key];
                }
              }
              return ret;
            }
            util.markAsOriginatingFromRejection(obj);
            return obj;
          }
          function nodebackForPromise(promise, multiArgs) {
            return function(err, value) {
              if (promise === null)
                return;
              if (err) {
                var wrapped = wrapAsOperationalError(maybeWrapAsError(err));
                promise._attachExtraTrace(wrapped);
                promise._reject(wrapped);
              } else if (!multiArgs) {
                promise._fulfill(value);
              } else {
                var args = [].slice.call(arguments, 1);
                ;
                promise._fulfill(args);
              }
              promise = null;
            };
          }
          module.exports = nodebackForPromise;
        }, {
          "./errors": 12,
          "./es5": 13,
          "./util": 36
        }],
        21: [function(_dereq_, module, exports) {
          "use strict";
          module.exports = function(Promise) {
            var util = _dereq_("./util");
            var async = Promise._async;
            var tryCatch = util.tryCatch;
            var errorObj = util.errorObj;
            function spreadAdapter(val, nodeback) {
              var promise = this;
              if (!util.isArray(val))
                return successAdapter.call(promise, val, nodeback);
              var ret = tryCatch(nodeback).apply(promise._boundValue(), [null].concat(val));
              if (ret === errorObj) {
                async.throwLater(ret.e);
              }
            }
            function successAdapter(val, nodeback) {
              var promise = this;
              var receiver = promise._boundValue();
              var ret = val === undefined ? tryCatch(nodeback).call(receiver, null) : tryCatch(nodeback).call(receiver, null, val);
              if (ret === errorObj) {
                async.throwLater(ret.e);
              }
            }
            function errorAdapter(reason, nodeback) {
              var promise = this;
              if (!reason) {
                var newReason = new Error(reason + "");
                newReason.cause = reason;
                reason = newReason;
              }
              var ret = tryCatch(nodeback).call(promise._boundValue(), reason);
              if (ret === errorObj) {
                async.throwLater(ret.e);
              }
            }
            Promise.prototype.asCallback = Promise.prototype.nodeify = function(nodeback, options) {
              if (typeof nodeback == "function") {
                var adapter = successAdapter;
                if (options !== undefined && Object(options).spread) {
                  adapter = spreadAdapter;
                }
                this._then(adapter, errorAdapter, undefined, this, nodeback);
              }
              return this;
            };
          };
        }, {"./util": 36}],
        22: [function(_dereq_, module, exports) {
          "use strict";
          module.exports = function() {
            var makeSelfResolutionError = function() {
              return new TypeError("circular promise resolution chain\u000a\u000a    See http://goo.gl/MqrFmX\u000a");
            };
            var reflectHandler = function() {
              return new Promise.PromiseInspection(this._target());
            };
            var apiRejection = function(msg) {
              return Promise.reject(new TypeError(msg));
            };
            function Proxyable() {}
            var UNDEFINED_BINDING = {};
            var util = _dereq_("./util");
            var getDomain;
            if (util.isNode) {
              getDomain = function() {
                var ret = process.domain;
                if (ret === undefined)
                  ret = null;
                return ret;
              };
            } else {
              getDomain = function() {
                return null;
              };
            }
            util.notEnumerableProp(Promise, "_getDomain", getDomain);
            var es5 = _dereq_("./es5");
            var Async = _dereq_("./async");
            var async = new Async();
            es5.defineProperty(Promise, "_async", {value: async});
            var errors = _dereq_("./errors");
            var TypeError = Promise.TypeError = errors.TypeError;
            Promise.RangeError = errors.RangeError;
            var CancellationError = Promise.CancellationError = errors.CancellationError;
            Promise.TimeoutError = errors.TimeoutError;
            Promise.OperationalError = errors.OperationalError;
            Promise.RejectionError = errors.OperationalError;
            Promise.AggregateError = errors.AggregateError;
            var INTERNAL = function() {};
            var APPLY = {};
            var NEXT_FILTER = {};
            var tryConvertToPromise = _dereq_("./thenables")(Promise, INTERNAL);
            var PromiseArray = _dereq_("./promise_array")(Promise, INTERNAL, tryConvertToPromise, apiRejection, Proxyable);
            var Context = _dereq_("./context")(Promise);
            var createContext = Context.create;
            var debug = _dereq_("./debuggability")(Promise, Context);
            var CapturedTrace = debug.CapturedTrace;
            var finallyHandler = _dereq_("./finally")(Promise, tryConvertToPromise);
            var catchFilter = _dereq_("./catch_filter")(NEXT_FILTER);
            var nodebackForPromise = _dereq_("./nodeback");
            var errorObj = util.errorObj;
            var tryCatch = util.tryCatch;
            function check(self, executor) {
              if (typeof executor !== "function") {
                throw new TypeError("expecting a function but got " + util.classString(executor));
              }
              if (self.constructor !== Promise) {
                throw new TypeError("the promise constructor cannot be invoked directly\u000a\u000a    See http://goo.gl/MqrFmX\u000a");
              }
            }
            function Promise(executor) {
              this._bitField = 0;
              this._fulfillmentHandler0 = undefined;
              this._rejectionHandler0 = undefined;
              this._promise0 = undefined;
              this._receiver0 = undefined;
              if (executor !== INTERNAL) {
                check(this, executor);
                this._resolveFromExecutor(executor);
              }
              this._promiseCreated();
            }
            Promise.prototype.toString = function() {
              return "[object Promise]";
            };
            Promise.prototype.caught = Promise.prototype["catch"] = function(fn) {
              var len = arguments.length;
              if (len > 1) {
                var catchInstances = new Array(len - 1),
                    j = 0,
                    i;
                for (i = 0; i < len - 1; ++i) {
                  var item = arguments[i];
                  if (util.isObject(item)) {
                    catchInstances[j++] = item;
                  } else {
                    return apiRejection("expecting an object but got " + util.classString(item));
                  }
                }
                catchInstances.length = j;
                fn = arguments[i];
                return this.then(undefined, catchFilter(catchInstances, fn, this));
              }
              return this.then(undefined, fn);
            };
            Promise.prototype.reflect = function() {
              return this._then(reflectHandler, reflectHandler, undefined, this, undefined);
            };
            Promise.prototype.then = function(didFulfill, didReject) {
              if (debug.warnings() && arguments.length > 0 && typeof didFulfill !== "function" && typeof didReject !== "function") {
                var msg = ".then() only accepts functions but was passed: " + util.classString(didFulfill);
                if (arguments.length > 1) {
                  msg += ", " + util.classString(didReject);
                }
                this._warn(msg);
              }
              return this._then(didFulfill, didReject, undefined, undefined, undefined);
            };
            Promise.prototype.done = function(didFulfill, didReject) {
              var promise = this._then(didFulfill, didReject, undefined, undefined, undefined);
              promise._setIsFinal();
            };
            Promise.prototype.spread = function(fn) {
              if (typeof fn !== "function") {
                return apiRejection("expecting a function but got " + util.classString(fn));
              }
              return this.all()._then(fn, undefined, undefined, APPLY, undefined);
            };
            Promise.prototype.toJSON = function() {
              var ret = {
                isFulfilled: false,
                isRejected: false,
                fulfillmentValue: undefined,
                rejectionReason: undefined
              };
              if (this.isFulfilled()) {
                ret.fulfillmentValue = this.value();
                ret.isFulfilled = true;
              } else if (this.isRejected()) {
                ret.rejectionReason = this.reason();
                ret.isRejected = true;
              }
              return ret;
            };
            Promise.prototype.all = function() {
              if (arguments.length > 0) {
                this._warn(".all() was passed arguments but it does not take any");
              }
              return new PromiseArray(this).promise();
            };
            Promise.prototype.error = function(fn) {
              return this.caught(util.originatesFromRejection, fn);
            };
            Promise.is = function(val) {
              return val instanceof Promise;
            };
            Promise.fromNode = Promise.fromCallback = function(fn) {
              var ret = new Promise(INTERNAL);
              var multiArgs = arguments.length > 1 ? !!Object(arguments[1]).multiArgs : false;
              var result = tryCatch(fn)(nodebackForPromise(ret, multiArgs));
              if (result === errorObj) {
                ret._rejectCallback(result.e, true);
              }
              if (!ret._isFateSealed())
                ret._setAsyncGuaranteed();
              return ret;
            };
            Promise.all = function(promises) {
              return new PromiseArray(promises).promise();
            };
            Promise.cast = function(obj) {
              var ret = tryConvertToPromise(obj);
              if (!(ret instanceof Promise)) {
                ret = new Promise(INTERNAL);
                ret._captureStackTrace();
                ret._setFulfilled();
                ret._rejectionHandler0 = obj;
              }
              return ret;
            };
            Promise.resolve = Promise.fulfilled = Promise.cast;
            Promise.reject = Promise.rejected = function(reason) {
              var ret = new Promise(INTERNAL);
              ret._captureStackTrace();
              ret._rejectCallback(reason, true);
              return ret;
            };
            Promise.setScheduler = function(fn) {
              if (typeof fn !== "function") {
                throw new TypeError("expecting a function but got " + util.classString(fn));
              }
              var prev = async._schedule;
              async._schedule = fn;
              return prev;
            };
            Promise.prototype._then = function(didFulfill, didReject, _, receiver, internalData) {
              var haveInternalData = internalData !== undefined;
              var promise = haveInternalData ? internalData : new Promise(INTERNAL);
              var target = this._target();
              var bitField = target._bitField;
              if (!haveInternalData) {
                promise._propagateFrom(this, 3);
                promise._captureStackTrace();
                if (receiver === undefined && ((this._bitField & 2097152) !== 0)) {
                  if (!((bitField & 50397184) === 0)) {
                    receiver = this._boundValue();
                  } else {
                    receiver = target === this ? undefined : this._boundTo;
                  }
                }
              }
              var domain = getDomain();
              if (!((bitField & 50397184) === 0)) {
                var handler,
                    value,
                    settler = target._settlePromiseCtx;
                if (((bitField & 33554432) !== 0)) {
                  value = target._rejectionHandler0;
                  handler = didFulfill;
                } else if (((bitField & 16777216) !== 0)) {
                  value = target._fulfillmentHandler0;
                  handler = didReject;
                  target._unsetRejectionIsUnhandled();
                } else {
                  settler = target._settlePromiseLateCancellationObserver;
                  value = new CancellationError("late cancellation observer");
                  target._attachExtraTrace(value);
                  handler = didReject;
                }
                async.invoke(settler, target, {
                  handler: domain === null ? handler : (typeof handler === "function" && domain.bind(handler)),
                  promise: promise,
                  receiver: receiver,
                  value: value
                });
              } else {
                target._addCallbacks(didFulfill, didReject, promise, receiver, domain);
              }
              return promise;
            };
            Promise.prototype._length = function() {
              return this._bitField & 65535;
            };
            Promise.prototype._isFateSealed = function() {
              return (this._bitField & 117506048) !== 0;
            };
            Promise.prototype._isFollowing = function() {
              return (this._bitField & 67108864) === 67108864;
            };
            Promise.prototype._setLength = function(len) {
              this._bitField = (this._bitField & -65536) | (len & 65535);
            };
            Promise.prototype._setFulfilled = function() {
              this._bitField = this._bitField | 33554432;
            };
            Promise.prototype._setRejected = function() {
              this._bitField = this._bitField | 16777216;
            };
            Promise.prototype._setFollowing = function() {
              this._bitField = this._bitField | 67108864;
            };
            Promise.prototype._setIsFinal = function() {
              this._bitField = this._bitField | 4194304;
            };
            Promise.prototype._isFinal = function() {
              return (this._bitField & 4194304) > 0;
            };
            Promise.prototype._unsetCancelled = function() {
              this._bitField = this._bitField & (~65536);
            };
            Promise.prototype._setCancelled = function() {
              this._bitField = this._bitField | 65536;
            };
            Promise.prototype._setAsyncGuaranteed = function() {
              this._bitField = this._bitField | 134217728;
            };
            Promise.prototype._receiverAt = function(index) {
              var ret = index === 0 ? this._receiver0 : this[index * 4 - 4 + 3];
              if (ret === UNDEFINED_BINDING) {
                return undefined;
              } else if (ret === undefined && this._isBound()) {
                return this._boundValue();
              }
              return ret;
            };
            Promise.prototype._promiseAt = function(index) {
              return this[index * 4 - 4 + 2];
            };
            Promise.prototype._fulfillmentHandlerAt = function(index) {
              return this[index * 4 - 4 + 0];
            };
            Promise.prototype._rejectionHandlerAt = function(index) {
              return this[index * 4 - 4 + 1];
            };
            Promise.prototype._boundValue = function() {};
            Promise.prototype._migrateCallback0 = function(follower) {
              var bitField = follower._bitField;
              var fulfill = follower._fulfillmentHandler0;
              var reject = follower._rejectionHandler0;
              var promise = follower._promise0;
              var receiver = follower._receiverAt(0);
              if (receiver === undefined)
                receiver = UNDEFINED_BINDING;
              this._addCallbacks(fulfill, reject, promise, receiver, null);
            };
            Promise.prototype._migrateCallbackAt = function(follower, index) {
              var fulfill = follower._fulfillmentHandlerAt(index);
              var reject = follower._rejectionHandlerAt(index);
              var promise = follower._promiseAt(index);
              var receiver = follower._receiverAt(index);
              if (receiver === undefined)
                receiver = UNDEFINED_BINDING;
              this._addCallbacks(fulfill, reject, promise, receiver, null);
            };
            Promise.prototype._addCallbacks = function(fulfill, reject, promise, receiver, domain) {
              var index = this._length();
              if (index >= 65535 - 4) {
                index = 0;
                this._setLength(0);
              }
              if (index === 0) {
                this._promise0 = promise;
                this._receiver0 = receiver;
                if (typeof fulfill === "function") {
                  this._fulfillmentHandler0 = domain === null ? fulfill : domain.bind(fulfill);
                }
                if (typeof reject === "function") {
                  this._rejectionHandler0 = domain === null ? reject : domain.bind(reject);
                }
              } else {
                var base = index * 4 - 4;
                this[base + 2] = promise;
                this[base + 3] = receiver;
                if (typeof fulfill === "function") {
                  this[base + 0] = domain === null ? fulfill : domain.bind(fulfill);
                }
                if (typeof reject === "function") {
                  this[base + 1] = domain === null ? reject : domain.bind(reject);
                }
              }
              this._setLength(index + 1);
              return index;
            };
            Promise.prototype._proxy = function(proxyable, arg) {
              this._addCallbacks(undefined, undefined, arg, proxyable, null);
            };
            Promise.prototype._resolveCallback = function(value, shouldBind) {
              if (((this._bitField & 117506048) !== 0))
                return;
              if (value === this)
                return this._rejectCallback(makeSelfResolutionError(), false);
              var maybePromise = tryConvertToPromise(value, this);
              if (!(maybePromise instanceof Promise))
                return this._fulfill(value);
              if (shouldBind)
                this._propagateFrom(maybePromise, 2);
              var promise = maybePromise._target();
              var bitField = promise._bitField;
              if (((bitField & 50397184) === 0)) {
                var len = this._length();
                if (len > 0)
                  promise._migrateCallback0(this);
                for (var i = 1; i < len; ++i) {
                  promise._migrateCallbackAt(this, i);
                }
                this._setFollowing();
                this._setLength(0);
                this._setFollowee(promise);
              } else if (((bitField & 33554432) !== 0)) {
                this._fulfill(promise._value());
              } else if (((bitField & 16777216) !== 0)) {
                this._reject(promise._reason());
              } else {
                var reason = new CancellationError("late cancellation observer");
                promise._attachExtraTrace(reason);
                this._reject(reason);
              }
            };
            Promise.prototype._rejectCallback = function(reason, synchronous, ignoreNonErrorWarnings) {
              var trace = util.ensureErrorObject(reason);
              var hasStack = trace === reason;
              if (!hasStack && !ignoreNonErrorWarnings && debug.warnings()) {
                var message = "a promise was rejected with a non-error: " + util.classString(reason);
                this._warn(message, true);
              }
              this._attachExtraTrace(trace, synchronous ? hasStack : false);
              this._reject(reason);
            };
            Promise.prototype._resolveFromExecutor = function(executor) {
              var promise = this;
              this._captureStackTrace();
              this._pushContext();
              var synchronous = true;
              var r = this._execute(executor, function(value) {
                promise._resolveCallback(value);
              }, function(reason) {
                promise._rejectCallback(reason, synchronous);
              });
              synchronous = false;
              this._popContext();
              if (r !== undefined) {
                promise._rejectCallback(r, true);
              }
            };
            Promise.prototype._settlePromiseFromHandler = function(handler, receiver, value, promise) {
              var bitField = promise._bitField;
              if (((bitField & 65536) !== 0))
                return;
              promise._pushContext();
              var x;
              if (receiver === APPLY) {
                if (!value || typeof value.length !== "number") {
                  x = errorObj;
                  x.e = new TypeError("cannot .spread() a non-array: " + util.classString(value));
                } else {
                  x = tryCatch(handler).apply(this._boundValue(), value);
                }
              } else {
                x = tryCatch(handler).call(receiver, value);
              }
              var promiseCreated = promise._popContext();
              bitField = promise._bitField;
              if (((bitField & 65536) !== 0))
                return;
              if (x === NEXT_FILTER) {
                promise._reject(value);
              } else if (x === errorObj || x === promise) {
                var err = x === promise ? makeSelfResolutionError() : x.e;
                promise._rejectCallback(err, false);
              } else {
                debug.checkForgottenReturns(x, promiseCreated, "", promise, this);
                promise._resolveCallback(x);
              }
            };
            Promise.prototype._target = function() {
              var ret = this;
              while (ret._isFollowing())
                ret = ret._followee();
              return ret;
            };
            Promise.prototype._followee = function() {
              return this._rejectionHandler0;
            };
            Promise.prototype._setFollowee = function(promise) {
              this._rejectionHandler0 = promise;
            };
            Promise.prototype._settlePromise = function(promise, handler, receiver, value) {
              var isPromise = promise instanceof Promise;
              var bitField = this._bitField;
              var asyncGuaranteed = ((bitField & 134217728) !== 0);
              if (((bitField & 65536) !== 0)) {
                if (isPromise)
                  promise._invokeInternalOnCancel();
                if (handler === finallyHandler) {
                  receiver.cancelPromise = promise;
                  if (tryCatch(handler).call(receiver, value) === errorObj) {
                    promise._reject(errorObj.e);
                  }
                } else if (handler === reflectHandler) {
                  promise._fulfill(reflectHandler.call(receiver));
                } else if (receiver instanceof Proxyable) {
                  receiver._promiseCancelled(promise);
                } else if (isPromise || promise instanceof PromiseArray) {
                  promise._cancel();
                } else {
                  receiver.cancel();
                }
              } else if (typeof handler === "function") {
                if (!isPromise) {
                  handler.call(receiver, value, promise);
                } else {
                  if (asyncGuaranteed)
                    promise._setAsyncGuaranteed();
                  this._settlePromiseFromHandler(handler, receiver, value, promise);
                }
              } else if (receiver instanceof Proxyable) {
                if (!receiver._isResolved()) {
                  if (((bitField & 33554432) !== 0)) {
                    receiver._promiseFulfilled(value, promise);
                  } else {
                    receiver._promiseRejected(value, promise);
                  }
                }
              } else if (isPromise) {
                if (asyncGuaranteed)
                  promise._setAsyncGuaranteed();
                if (((bitField & 33554432) !== 0)) {
                  promise._fulfill(value);
                } else {
                  promise._reject(value);
                }
              }
            };
            Promise.prototype._settlePromiseLateCancellationObserver = function(ctx) {
              var handler = ctx.handler;
              var promise = ctx.promise;
              var receiver = ctx.receiver;
              var value = ctx.value;
              if (typeof handler === "function") {
                if (!(promise instanceof Promise)) {
                  handler.call(receiver, value, promise);
                } else {
                  this._settlePromiseFromHandler(handler, receiver, value, promise);
                }
              } else if (promise instanceof Promise) {
                promise._reject(value);
              }
            };
            Promise.prototype._settlePromiseCtx = function(ctx) {
              this._settlePromise(ctx.promise, ctx.handler, ctx.receiver, ctx.value);
            };
            Promise.prototype._settlePromise0 = function(handler, value, bitField) {
              var promise = this._promise0;
              var receiver = this._receiverAt(0);
              this._promise0 = undefined;
              this._receiver0 = undefined;
              this._settlePromise(promise, handler, receiver, value);
            };
            Promise.prototype._clearCallbackDataAtIndex = function(index) {
              var base = index * 4 - 4;
              this[base + 2] = this[base + 3] = this[base + 0] = this[base + 1] = undefined;
            };
            Promise.prototype._fulfill = function(value) {
              var bitField = this._bitField;
              if (((bitField & 117506048) >>> 16))
                return;
              if (value === this) {
                var err = makeSelfResolutionError();
                this._attachExtraTrace(err);
                return this._reject(err);
              }
              this._setFulfilled();
              this._rejectionHandler0 = value;
              if ((bitField & 65535) > 0) {
                if (((bitField & 134217728) !== 0)) {
                  this._settlePromises();
                } else {
                  async.settlePromises(this);
                }
              }
            };
            Promise.prototype._reject = function(reason) {
              var bitField = this._bitField;
              if (((bitField & 117506048) >>> 16))
                return;
              this._setRejected();
              this._fulfillmentHandler0 = reason;
              if (this._isFinal()) {
                return async.fatalError(reason, util.isNode);
              }
              if ((bitField & 65535) > 0) {
                if (((bitField & 134217728) !== 0)) {
                  this._settlePromises();
                } else {
                  async.settlePromises(this);
                }
              } else {
                this._ensurePossibleRejectionHandled();
              }
            };
            Promise.prototype._fulfillPromises = function(len, value) {
              for (var i = 1; i < len; i++) {
                var handler = this._fulfillmentHandlerAt(i);
                var promise = this._promiseAt(i);
                var receiver = this._receiverAt(i);
                this._clearCallbackDataAtIndex(i);
                this._settlePromise(promise, handler, receiver, value);
              }
            };
            Promise.prototype._rejectPromises = function(len, reason) {
              for (var i = 1; i < len; i++) {
                var handler = this._rejectionHandlerAt(i);
                var promise = this._promiseAt(i);
                var receiver = this._receiverAt(i);
                this._clearCallbackDataAtIndex(i);
                this._settlePromise(promise, handler, receiver, reason);
              }
            };
            Promise.prototype._settlePromises = function() {
              var bitField = this._bitField;
              var len = (bitField & 65535);
              if (len > 0) {
                if (((bitField & 16842752) !== 0)) {
                  var reason = this._fulfillmentHandler0;
                  this._settlePromise0(this._rejectionHandler0, reason, bitField);
                  this._rejectPromises(len, reason);
                } else {
                  var value = this._rejectionHandler0;
                  this._settlePromise0(this._fulfillmentHandler0, value, bitField);
                  this._fulfillPromises(len, value);
                }
                this._setLength(0);
              }
              this._clearCancellationData();
            };
            Promise.prototype._settledValue = function() {
              var bitField = this._bitField;
              if (((bitField & 33554432) !== 0)) {
                return this._rejectionHandler0;
              } else if (((bitField & 16777216) !== 0)) {
                return this._fulfillmentHandler0;
              }
            };
            function deferResolve(v) {
              this.promise._resolveCallback(v);
            }
            function deferReject(v) {
              this.promise._rejectCallback(v, false);
            }
            Promise.defer = Promise.pending = function() {
              debug.deprecated("Promise.defer", "new Promise");
              var promise = new Promise(INTERNAL);
              return {
                promise: promise,
                resolve: deferResolve,
                reject: deferReject
              };
            };
            util.notEnumerableProp(Promise, "_makeSelfResolutionError", makeSelfResolutionError);
            _dereq_("./method")(Promise, INTERNAL, tryConvertToPromise, apiRejection, debug);
            _dereq_("./bind")(Promise, INTERNAL, tryConvertToPromise, debug);
            _dereq_("./cancel")(Promise, PromiseArray, apiRejection, debug);
            _dereq_("./direct_resolve")(Promise);
            _dereq_("./synchronous_inspection")(Promise);
            _dereq_("./join")(Promise, PromiseArray, tryConvertToPromise, INTERNAL, debug);
            Promise.Promise = Promise;
            _dereq_('./map.js')(Promise, PromiseArray, apiRejection, tryConvertToPromise, INTERNAL, debug);
            _dereq_('./using.js')(Promise, apiRejection, tryConvertToPromise, createContext, INTERNAL, debug);
            _dereq_('./timers.js')(Promise, INTERNAL);
            _dereq_('./generators.js')(Promise, apiRejection, INTERNAL, tryConvertToPromise, Proxyable, debug);
            _dereq_('./nodeify.js')(Promise);
            _dereq_('./call_get.js')(Promise);
            _dereq_('./props.js')(Promise, PromiseArray, tryConvertToPromise, apiRejection);
            _dereq_('./race.js')(Promise, INTERNAL, tryConvertToPromise, apiRejection);
            _dereq_('./reduce.js')(Promise, PromiseArray, apiRejection, tryConvertToPromise, INTERNAL, debug);
            _dereq_('./settle.js')(Promise, PromiseArray, debug);
            _dereq_('./some.js')(Promise, PromiseArray, apiRejection);
            _dereq_('./promisify.js')(Promise, INTERNAL);
            _dereq_('./any.js')(Promise);
            _dereq_('./each.js')(Promise, INTERNAL);
            _dereq_('./filter.js')(Promise, INTERNAL);
            util.toFastProperties(Promise);
            util.toFastProperties(Promise.prototype);
            function fillTypes(value) {
              var p = new Promise(INTERNAL);
              p._fulfillmentHandler0 = value;
              p._rejectionHandler0 = value;
              p._promise0 = value;
              p._receiver0 = value;
            }
            fillTypes({a: 1});
            fillTypes({b: 2});
            fillTypes({c: 3});
            fillTypes(1);
            fillTypes(function() {});
            fillTypes(undefined);
            fillTypes(false);
            fillTypes(new Promise(INTERNAL));
            debug.setBounds(Async.firstLineError, util.lastLineError);
            return Promise;
          };
        }, {
          "./any.js": 1,
          "./async": 2,
          "./bind": 3,
          "./call_get.js": 5,
          "./cancel": 6,
          "./catch_filter": 7,
          "./context": 8,
          "./debuggability": 9,
          "./direct_resolve": 10,
          "./each.js": 11,
          "./errors": 12,
          "./es5": 13,
          "./filter.js": 14,
          "./finally": 15,
          "./generators.js": 16,
          "./join": 17,
          "./map.js": 18,
          "./method": 19,
          "./nodeback": 20,
          "./nodeify.js": 21,
          "./promise_array": 23,
          "./promisify.js": 24,
          "./props.js": 25,
          "./race.js": 27,
          "./reduce.js": 28,
          "./settle.js": 30,
          "./some.js": 31,
          "./synchronous_inspection": 32,
          "./thenables": 33,
          "./timers.js": 34,
          "./using.js": 35,
          "./util": 36
        }],
        23: [function(_dereq_, module, exports) {
          "use strict";
          module.exports = function(Promise, INTERNAL, tryConvertToPromise, apiRejection, Proxyable) {
            var util = _dereq_("./util");
            var isArray = util.isArray;
            function toResolutionValue(val) {
              switch (val) {
                case -2:
                  return [];
                case -3:
                  return {};
              }
            }
            function PromiseArray(values) {
              var promise = this._promise = new Promise(INTERNAL);
              if (values instanceof Promise) {
                promise._propagateFrom(values, 3);
              }
              promise._setOnCancel(this);
              this._values = values;
              this._length = 0;
              this._totalResolved = 0;
              this._init(undefined, -2);
            }
            util.inherits(PromiseArray, Proxyable);
            PromiseArray.prototype.length = function() {
              return this._length;
            };
            PromiseArray.prototype.promise = function() {
              return this._promise;
            };
            PromiseArray.prototype._init = function init(_, resolveValueIfEmpty) {
              var values = tryConvertToPromise(this._values, this._promise);
              if (values instanceof Promise) {
                values = values._target();
                var bitField = values._bitField;
                ;
                this._values = values;
                if (((bitField & 50397184) === 0)) {
                  this._promise._setAsyncGuaranteed();
                  return values._then(init, this._reject, undefined, this, resolveValueIfEmpty);
                } else if (((bitField & 33554432) !== 0)) {
                  values = values._value();
                } else if (((bitField & 16777216) !== 0)) {
                  return this._reject(values._reason());
                } else {
                  return this._cancel();
                }
              }
              values = util.asArray(values);
              if (values === null) {
                var err = apiRejection("expecting an array or an iterable object but got " + util.classString(values)).reason();
                this._promise._rejectCallback(err, false);
                return;
              }
              if (values.length === 0) {
                if (resolveValueIfEmpty === -5) {
                  this._resolveEmptyArray();
                } else {
                  this._resolve(toResolutionValue(resolveValueIfEmpty));
                }
                return;
              }
              this._iterate(values);
            };
            PromiseArray.prototype._iterate = function(values) {
              var len = this.getActualLength(values.length);
              this._length = len;
              this._values = this.shouldCopyValues() ? new Array(len) : this._values;
              var result = this._promise;
              var isResolved = false;
              var bitField = null;
              for (var i = 0; i < len; ++i) {
                var maybePromise = tryConvertToPromise(values[i], result);
                if (maybePromise instanceof Promise) {
                  maybePromise = maybePromise._target();
                  bitField = maybePromise._bitField;
                } else {
                  bitField = null;
                }
                if (isResolved) {
                  if (bitField !== null) {
                    maybePromise.suppressUnhandledRejections();
                  }
                } else if (bitField !== null) {
                  if (((bitField & 50397184) === 0)) {
                    maybePromise._proxy(this, i);
                    this._values[i] = maybePromise;
                  } else if (((bitField & 33554432) !== 0)) {
                    isResolved = this._promiseFulfilled(maybePromise._value(), i);
                  } else if (((bitField & 16777216) !== 0)) {
                    isResolved = this._promiseRejected(maybePromise._reason(), i);
                  } else {
                    isResolved = this._promiseCancelled(i);
                  }
                } else {
                  isResolved = this._promiseFulfilled(maybePromise, i);
                }
              }
              if (!isResolved)
                result._setAsyncGuaranteed();
            };
            PromiseArray.prototype._isResolved = function() {
              return this._values === null;
            };
            PromiseArray.prototype._resolve = function(value) {
              this._values = null;
              this._promise._fulfill(value);
            };
            PromiseArray.prototype._cancel = function() {
              if (this._isResolved() || !this._promise.isCancellable())
                return;
              this._values = null;
              this._promise._cancel();
            };
            PromiseArray.prototype._reject = function(reason) {
              this._values = null;
              this._promise._rejectCallback(reason, false);
            };
            PromiseArray.prototype._promiseFulfilled = function(value, index) {
              this._values[index] = value;
              var totalResolved = ++this._totalResolved;
              if (totalResolved >= this._length) {
                this._resolve(this._values);
                return true;
              }
              return false;
            };
            PromiseArray.prototype._promiseCancelled = function() {
              this._cancel();
              return true;
            };
            PromiseArray.prototype._promiseRejected = function(reason) {
              this._totalResolved++;
              this._reject(reason);
              return true;
            };
            PromiseArray.prototype._resultCancelled = function() {
              if (this._isResolved())
                return;
              var values = this._values;
              this._cancel();
              if (values instanceof Promise) {
                values.cancel();
              } else {
                for (var i = 0; i < values.length; ++i) {
                  if (values[i] instanceof Promise) {
                    values[i].cancel();
                  }
                }
              }
            };
            PromiseArray.prototype.shouldCopyValues = function() {
              return true;
            };
            PromiseArray.prototype.getActualLength = function(len) {
              return len;
            };
            return PromiseArray;
          };
        }, {"./util": 36}],
        24: [function(_dereq_, module, exports) {
          "use strict";
          module.exports = function(Promise, INTERNAL) {
            var THIS = {};
            var util = _dereq_("./util");
            var nodebackForPromise = _dereq_("./nodeback");
            var withAppended = util.withAppended;
            var maybeWrapAsError = util.maybeWrapAsError;
            var canEvaluate = util.canEvaluate;
            var TypeError = _dereq_("./errors").TypeError;
            var defaultSuffix = "Async";
            var defaultPromisified = {__isPromisified__: true};
            var noCopyProps = ["arity", "length", "name", "arguments", "caller", "callee", "prototype", "__isPromisified__"];
            var noCopyPropsPattern = new RegExp("^(?:" + noCopyProps.join("|") + ")$");
            var defaultFilter = function(name) {
              return util.isIdentifier(name) && name.charAt(0) !== "_" && name !== "constructor";
            };
            function propsFilter(key) {
              return !noCopyPropsPattern.test(key);
            }
            function isPromisified(fn) {
              try {
                return fn.__isPromisified__ === true;
              } catch (e) {
                return false;
              }
            }
            function hasPromisified(obj, key, suffix) {
              var val = util.getDataPropertyOrDefault(obj, key + suffix, defaultPromisified);
              return val ? isPromisified(val) : false;
            }
            function checkValid(ret, suffix, suffixRegexp) {
              for (var i = 0; i < ret.length; i += 2) {
                var key = ret[i];
                if (suffixRegexp.test(key)) {
                  var keyWithoutAsyncSuffix = key.replace(suffixRegexp, "");
                  for (var j = 0; j < ret.length; j += 2) {
                    if (ret[j] === keyWithoutAsyncSuffix) {
                      throw new TypeError("Cannot promisify an API that has normal methods with '%s'-suffix\u000a\u000a    See http://goo.gl/MqrFmX\u000a".replace("%s", suffix));
                    }
                  }
                }
              }
            }
            function promisifiableMethods(obj, suffix, suffixRegexp, filter) {
              var keys = util.inheritedDataKeys(obj);
              var ret = [];
              for (var i = 0; i < keys.length; ++i) {
                var key = keys[i];
                var value = obj[key];
                var passesDefaultFilter = filter === defaultFilter ? true : defaultFilter(key, value, obj);
                if (typeof value === "function" && !isPromisified(value) && !hasPromisified(obj, key, suffix) && filter(key, value, obj, passesDefaultFilter)) {
                  ret.push(key, value);
                }
              }
              checkValid(ret, suffix, suffixRegexp);
              return ret;
            }
            var escapeIdentRegex = function(str) {
              return str.replace(/([$])/, "\\$");
            };
            var makeNodePromisifiedEval;
            if (!true) {
              var switchCaseArgumentOrder = function(likelyArgumentCount) {
                var ret = [likelyArgumentCount];
                var min = Math.max(0, likelyArgumentCount - 1 - 3);
                for (var i = likelyArgumentCount - 1; i >= min; --i) {
                  ret.push(i);
                }
                for (var i = likelyArgumentCount + 1; i <= 3; ++i) {
                  ret.push(i);
                }
                return ret;
              };
              var argumentSequence = function(argumentCount) {
                return util.filledRange(argumentCount, "_arg", "");
              };
              var parameterDeclaration = function(parameterCount) {
                return util.filledRange(Math.max(parameterCount, 3), "_arg", "");
              };
              var parameterCount = function(fn) {
                if (typeof fn.length === "number") {
                  return Math.max(Math.min(fn.length, 1023 + 1), 0);
                }
                return 0;
              };
              makeNodePromisifiedEval = function(callback, receiver, originalName, fn, _, multiArgs) {
                var newParameterCount = Math.max(0, parameterCount(fn) - 1);
                var argumentOrder = switchCaseArgumentOrder(newParameterCount);
                var shouldProxyThis = typeof callback === "string" || receiver === THIS;
                function generateCallForArgumentCount(count) {
                  var args = argumentSequence(count).join(", ");
                  var comma = count > 0 ? ", " : "";
                  var ret;
                  if (shouldProxyThis) {
                    ret = "ret = callback.call(this, {{args}}, nodeback); break;\n";
                  } else {
                    ret = receiver === undefined ? "ret = callback({{args}}, nodeback); break;\n" : "ret = callback.call(receiver, {{args}}, nodeback); break;\n";
                  }
                  return ret.replace("{{args}}", args).replace(", ", comma);
                }
                function generateArgumentSwitchCase() {
                  var ret = "";
                  for (var i = 0; i < argumentOrder.length; ++i) {
                    ret += "case " + argumentOrder[i] + ":" + generateCallForArgumentCount(argumentOrder[i]);
                  }
                  ret += "                                                             \n\
        default:                                                             \n\
            var args = new Array(len + 1);                                   \n\
            var i = 0;                                                       \n\
            for (var i = 0; i < len; ++i) {                                  \n\
               args[i] = arguments[i];                                       \n\
            }                                                                \n\
            args[i] = nodeback;                                              \n\
            [CodeForCall]                                                    \n\
            break;                                                           \n\
        ".replace("[CodeForCall]", (shouldProxyThis ? "ret = callback.apply(this, args);\n" : "ret = callback.apply(receiver, args);\n"));
                  return ret;
                }
                var getFunctionCode = typeof callback === "string" ? ("this != null ? this['" + callback + "'] : fn") : "fn";
                var body = "'use strict';                                                \n\
        var ret = function (Parameters) {                                    \n\
            'use strict';                                                    \n\
            var len = arguments.length;                                      \n\
            var promise = new Promise(INTERNAL);                             \n\
            promise._captureStackTrace();                                    \n\
            var nodeback = nodebackForPromise(promise, " + multiArgs + ");   \n\
            var ret;                                                         \n\
            var callback = tryCatch([GetFunctionCode]);                      \n\
            switch(len) {                                                    \n\
                [CodeForSwitchCase]                                          \n\
            }                                                                \n\
            if (ret === errorObj) {                                          \n\
                promise._rejectCallback(maybeWrapAsError(ret.e), true, true);\n\
            }                                                                \n\
            if (!promise._isFateSealed()) promise._setAsyncGuaranteed();     \n\
            return promise;                                                  \n\
        };                                                                   \n\
        notEnumerableProp(ret, '__isPromisified__', true);                   \n\
        return ret;                                                          \n\
    ".replace("[CodeForSwitchCase]", generateArgumentSwitchCase()).replace("[GetFunctionCode]", getFunctionCode);
                body = body.replace("Parameters", parameterDeclaration(newParameterCount));
                return new Function("Promise", "fn", "receiver", "withAppended", "maybeWrapAsError", "nodebackForPromise", "tryCatch", "errorObj", "notEnumerableProp", "INTERNAL", body)(Promise, fn, receiver, withAppended, maybeWrapAsError, nodebackForPromise, util.tryCatch, util.errorObj, util.notEnumerableProp, INTERNAL);
              };
            }
            function makeNodePromisifiedClosure(callback, receiver, _, fn, __, multiArgs) {
              var defaultThis = (function() {
                return this;
              })();
              var method = callback;
              if (typeof method === "string") {
                callback = fn;
              }
              function promisified() {
                var _receiver = receiver;
                if (receiver === THIS)
                  _receiver = this;
                var promise = new Promise(INTERNAL);
                promise._captureStackTrace();
                var cb = typeof method === "string" && this !== defaultThis ? this[method] : callback;
                var fn = nodebackForPromise(promise, multiArgs);
                try {
                  cb.apply(_receiver, withAppended(arguments, fn));
                } catch (e) {
                  promise._rejectCallback(maybeWrapAsError(e), true, true);
                }
                if (!promise._isFateSealed())
                  promise._setAsyncGuaranteed();
                return promise;
              }
              util.notEnumerableProp(promisified, "__isPromisified__", true);
              return promisified;
            }
            var makeNodePromisified = canEvaluate ? makeNodePromisifiedEval : makeNodePromisifiedClosure;
            function promisifyAll(obj, suffix, filter, promisifier, multiArgs) {
              var suffixRegexp = new RegExp(escapeIdentRegex(suffix) + "$");
              var methods = promisifiableMethods(obj, suffix, suffixRegexp, filter);
              for (var i = 0,
                  len = methods.length; i < len; i += 2) {
                var key = methods[i];
                var fn = methods[i + 1];
                var promisifiedKey = key + suffix;
                if (promisifier === makeNodePromisified) {
                  obj[promisifiedKey] = makeNodePromisified(key, THIS, key, fn, suffix, multiArgs);
                } else {
                  var promisified = promisifier(fn, function() {
                    return makeNodePromisified(key, THIS, key, fn, suffix, multiArgs);
                  });
                  util.notEnumerableProp(promisified, "__isPromisified__", true);
                  obj[promisifiedKey] = promisified;
                }
              }
              util.toFastProperties(obj);
              return obj;
            }
            function promisify(callback, receiver, multiArgs) {
              return makeNodePromisified(callback, receiver, undefined, callback, null, multiArgs);
            }
            Promise.promisify = function(fn, options) {
              if (typeof fn !== "function") {
                throw new TypeError("expecting a function but got " + util.classString(fn));
              }
              if (isPromisified(fn)) {
                return fn;
              }
              options = Object(options);
              var receiver = options.context === undefined ? THIS : options.context;
              var multiArgs = !!options.multiArgs;
              var ret = promisify(fn, receiver, multiArgs);
              util.copyDescriptors(fn, ret, propsFilter);
              return ret;
            };
            Promise.promisifyAll = function(target, options) {
              if (typeof target !== "function" && typeof target !== "object") {
                throw new TypeError("the target of promisifyAll must be an object or a function\u000a\u000a    See http://goo.gl/MqrFmX\u000a");
              }
              options = Object(options);
              var multiArgs = !!options.multiArgs;
              var suffix = options.suffix;
              if (typeof suffix !== "string")
                suffix = defaultSuffix;
              var filter = options.filter;
              if (typeof filter !== "function")
                filter = defaultFilter;
              var promisifier = options.promisifier;
              if (typeof promisifier !== "function")
                promisifier = makeNodePromisified;
              if (!util.isIdentifier(suffix)) {
                throw new RangeError("suffix must be a valid identifier\u000a\u000a    See http://goo.gl/MqrFmX\u000a");
              }
              var keys = util.inheritedDataKeys(target);
              for (var i = 0; i < keys.length; ++i) {
                var value = target[keys[i]];
                if (keys[i] !== "constructor" && util.isClass(value)) {
                  promisifyAll(value.prototype, suffix, filter, promisifier, multiArgs);
                  promisifyAll(value, suffix, filter, promisifier, multiArgs);
                }
              }
              return promisifyAll(target, suffix, filter, promisifier, multiArgs);
            };
          };
        }, {
          "./errors": 12,
          "./nodeback": 20,
          "./util": 36
        }],
        25: [function(_dereq_, module, exports) {
          "use strict";
          module.exports = function(Promise, PromiseArray, tryConvertToPromise, apiRejection) {
            var util = _dereq_("./util");
            var isObject = util.isObject;
            var es5 = _dereq_("./es5");
            var Es6Map;
            if (typeof Map === "function")
              Es6Map = Map;
            var mapToEntries = (function() {
              var index = 0;
              var size = 0;
              function extractEntry(value, key) {
                this[index] = value;
                this[index + size] = key;
                index++;
              }
              return function mapToEntries(map) {
                size = map.size;
                index = 0;
                var ret = new Array(map.size * 2);
                map.forEach(extractEntry, ret);
                return ret;
              };
            })();
            var entriesToMap = function(entries) {
              var ret = new Es6Map();
              var length = entries.length / 2 | 0;
              for (var i = 0; i < length; ++i) {
                var key = entries[length + i];
                var value = entries[i];
                ret.set(key, value);
              }
              return ret;
            };
            function PropertiesPromiseArray(obj) {
              var isMap = false;
              var entries;
              if (Es6Map !== undefined && obj instanceof Es6Map) {
                entries = mapToEntries(obj);
                isMap = true;
              } else {
                var keys = es5.keys(obj);
                var len = keys.length;
                entries = new Array(len * 2);
                for (var i = 0; i < len; ++i) {
                  var key = keys[i];
                  entries[i] = obj[key];
                  entries[i + len] = key;
                }
              }
              this.constructor$(entries);
              this._isMap = isMap;
              this._init$(undefined, -3);
            }
            util.inherits(PropertiesPromiseArray, PromiseArray);
            PropertiesPromiseArray.prototype._init = function() {};
            PropertiesPromiseArray.prototype._promiseFulfilled = function(value, index) {
              this._values[index] = value;
              var totalResolved = ++this._totalResolved;
              if (totalResolved >= this._length) {
                var val;
                if (this._isMap) {
                  val = entriesToMap(this._values);
                } else {
                  val = {};
                  var keyOffset = this.length();
                  for (var i = 0,
                      len = this.length(); i < len; ++i) {
                    val[this._values[i + keyOffset]] = this._values[i];
                  }
                }
                this._resolve(val);
                return true;
              }
              return false;
            };
            PropertiesPromiseArray.prototype.shouldCopyValues = function() {
              return false;
            };
            PropertiesPromiseArray.prototype.getActualLength = function(len) {
              return len >> 1;
            };
            function props(promises) {
              var ret;
              var castValue = tryConvertToPromise(promises);
              if (!isObject(castValue)) {
                return apiRejection("cannot await properties of a non-object\u000a\u000a    See http://goo.gl/MqrFmX\u000a");
              } else if (castValue instanceof Promise) {
                ret = castValue._then(Promise.props, undefined, undefined, undefined, undefined);
              } else {
                ret = new PropertiesPromiseArray(castValue).promise();
              }
              if (castValue instanceof Promise) {
                ret._propagateFrom(castValue, 2);
              }
              return ret;
            }
            Promise.prototype.props = function() {
              return props(this);
            };
            Promise.props = function(promises) {
              return props(promises);
            };
          };
        }, {
          "./es5": 13,
          "./util": 36
        }],
        26: [function(_dereq_, module, exports) {
          "use strict";
          function arrayMove(src, srcIndex, dst, dstIndex, len) {
            for (var j = 0; j < len; ++j) {
              dst[j + dstIndex] = src[j + srcIndex];
              src[j + srcIndex] = void 0;
            }
          }
          function Queue(capacity) {
            this._capacity = capacity;
            this._length = 0;
            this._front = 0;
          }
          Queue.prototype._willBeOverCapacity = function(size) {
            return this._capacity < size;
          };
          Queue.prototype._pushOne = function(arg) {
            var length = this.length();
            this._checkCapacity(length + 1);
            var i = (this._front + length) & (this._capacity - 1);
            this[i] = arg;
            this._length = length + 1;
          };
          Queue.prototype._unshiftOne = function(value) {
            var capacity = this._capacity;
            this._checkCapacity(this.length() + 1);
            var front = this._front;
            var i = ((((front - 1) & (capacity - 1)) ^ capacity) - capacity);
            this[i] = value;
            this._front = i;
            this._length = this.length() + 1;
          };
          Queue.prototype.unshift = function(fn, receiver, arg) {
            this._unshiftOne(arg);
            this._unshiftOne(receiver);
            this._unshiftOne(fn);
          };
          Queue.prototype.push = function(fn, receiver, arg) {
            var length = this.length() + 3;
            if (this._willBeOverCapacity(length)) {
              this._pushOne(fn);
              this._pushOne(receiver);
              this._pushOne(arg);
              return;
            }
            var j = this._front + length - 3;
            this._checkCapacity(length);
            var wrapMask = this._capacity - 1;
            this[(j + 0) & wrapMask] = fn;
            this[(j + 1) & wrapMask] = receiver;
            this[(j + 2) & wrapMask] = arg;
            this._length = length;
          };
          Queue.prototype.shift = function() {
            var front = this._front,
                ret = this[front];
            this[front] = undefined;
            this._front = (front + 1) & (this._capacity - 1);
            this._length--;
            return ret;
          };
          Queue.prototype.length = function() {
            return this._length;
          };
          Queue.prototype._checkCapacity = function(size) {
            if (this._capacity < size) {
              this._resizeTo(this._capacity << 1);
            }
          };
          Queue.prototype._resizeTo = function(capacity) {
            var oldCapacity = this._capacity;
            this._capacity = capacity;
            var front = this._front;
            var length = this._length;
            var moveItemsCount = (front + length) & (oldCapacity - 1);
            arrayMove(this, 0, this, oldCapacity, moveItemsCount);
          };
          module.exports = Queue;
        }, {}],
        27: [function(_dereq_, module, exports) {
          "use strict";
          module.exports = function(Promise, INTERNAL, tryConvertToPromise, apiRejection) {
            var util = _dereq_("./util");
            var raceLater = function(promise) {
              return promise.then(function(array) {
                return race(array, promise);
              });
            };
            function race(promises, parent) {
              var maybePromise = tryConvertToPromise(promises);
              if (maybePromise instanceof Promise) {
                return raceLater(maybePromise);
              } else {
                promises = util.asArray(promises);
                if (promises === null)
                  return apiRejection("expecting an array or an iterable object but got " + util.classString(promises));
              }
              var ret = new Promise(INTERNAL);
              if (parent !== undefined) {
                ret._propagateFrom(parent, 3);
              }
              var fulfill = ret._fulfill;
              var reject = ret._reject;
              for (var i = 0,
                  len = promises.length; i < len; ++i) {
                var val = promises[i];
                if (val === undefined && !(i in promises)) {
                  continue;
                }
                Promise.cast(val)._then(fulfill, reject, undefined, ret, null);
              }
              return ret;
            }
            Promise.race = function(promises) {
              return race(promises, undefined);
            };
            Promise.prototype.race = function() {
              return race(this, undefined);
            };
          };
        }, {"./util": 36}],
        28: [function(_dereq_, module, exports) {
          "use strict";
          module.exports = function(Promise, PromiseArray, apiRejection, tryConvertToPromise, INTERNAL, debug) {
            var getDomain = Promise._getDomain;
            var util = _dereq_("./util");
            var tryCatch = util.tryCatch;
            function ReductionPromiseArray(promises, fn, initialValue, _each) {
              this.constructor$(promises);
              var domain = getDomain();
              this._fn = domain === null ? fn : domain.bind(fn);
              if (initialValue !== undefined) {
                initialValue = Promise.resolve(initialValue);
                initialValue._attachCancellationCallback(this);
              }
              this._initialValue = initialValue;
              this._currentCancellable = null;
              this._eachValues = _each === INTERNAL ? [] : undefined;
              this._promise._captureStackTrace();
              this._init$(undefined, -5);
            }
            util.inherits(ReductionPromiseArray, PromiseArray);
            ReductionPromiseArray.prototype._gotAccum = function(accum) {
              if (this._eachValues !== undefined && accum !== INTERNAL) {
                this._eachValues.push(accum);
              }
            };
            ReductionPromiseArray.prototype._eachComplete = function(value) {
              this._eachValues.push(value);
              return this._eachValues;
            };
            ReductionPromiseArray.prototype._init = function() {};
            ReductionPromiseArray.prototype._resolveEmptyArray = function() {
              this._resolve(this._eachValues !== undefined ? this._eachValues : this._initialValue);
            };
            ReductionPromiseArray.prototype.shouldCopyValues = function() {
              return false;
            };
            ReductionPromiseArray.prototype._resolve = function(value) {
              this._promise._resolveCallback(value);
              this._values = null;
            };
            ReductionPromiseArray.prototype._resultCancelled = function(sender) {
              if (sender === this._initialValue)
                return this._cancel();
              if (this._isResolved())
                return;
              this._resultCancelled$();
              if (this._currentCancellable instanceof Promise) {
                this._currentCancellable.cancel();
              }
              if (this._initialValue instanceof Promise) {
                this._initialValue.cancel();
              }
            };
            ReductionPromiseArray.prototype._iterate = function(values) {
              this._values = values;
              var value;
              var i;
              var length = values.length;
              if (this._initialValue !== undefined) {
                value = this._initialValue;
                i = 0;
              } else {
                value = Promise.resolve(values[0]);
                i = 1;
              }
              this._currentCancellable = value;
              if (!value.isRejected()) {
                for (; i < length; ++i) {
                  var ctx = {
                    accum: null,
                    value: values[i],
                    index: i,
                    length: length,
                    array: this
                  };
                  value = value._then(gotAccum, undefined, undefined, ctx, undefined);
                }
              }
              if (this._eachValues !== undefined) {
                value = value._then(this._eachComplete, undefined, undefined, this, undefined);
              }
              value._then(completed, completed, undefined, value, this);
            };
            Promise.prototype.reduce = function(fn, initialValue) {
              return reduce(this, fn, initialValue, null);
            };
            Promise.reduce = function(promises, fn, initialValue, _each) {
              return reduce(promises, fn, initialValue, _each);
            };
            function completed(valueOrReason, array) {
              if (this.isFulfilled()) {
                array._resolve(valueOrReason);
              } else {
                array._reject(valueOrReason);
              }
            }
            function reduce(promises, fn, initialValue, _each) {
              if (typeof fn !== "function") {
                return apiRejection("expecting a function but got " + util.classString(fn));
              }
              var array = new ReductionPromiseArray(promises, fn, initialValue, _each);
              return array.promise();
            }
            function gotAccum(accum) {
              this.accum = accum;
              this.array._gotAccum(accum);
              var value = tryConvertToPromise(this.value, this.array._promise);
              if (value instanceof Promise) {
                this.array._currentCancellable = value;
                return value._then(gotValue, undefined, undefined, this, undefined);
              } else {
                return gotValue.call(this, value);
              }
            }
            function gotValue(value) {
              var array = this.array;
              var promise = array._promise;
              var fn = tryCatch(array._fn);
              promise._pushContext();
              var ret;
              if (array._eachValues !== undefined) {
                ret = fn.call(promise._boundValue(), value, this.index, this.length);
              } else {
                ret = fn.call(promise._boundValue(), this.accum, value, this.index, this.length);
              }
              if (ret instanceof Promise) {
                array._currentCancellable = ret;
              }
              var promiseCreated = promise._popContext();
              debug.checkForgottenReturns(ret, promiseCreated, array._eachValues !== undefined ? "Promise.each" : "Promise.reduce", promise);
              return ret;
            }
          };
        }, {"./util": 36}],
        29: [function(_dereq_, module, exports) {
          "use strict";
          var util = _dereq_("./util");
          var schedule;
          var noAsyncScheduler = function() {
            throw new Error("No async scheduler available\u000a\u000a    See http://goo.gl/MqrFmX\u000a");
          };
          if (util.isNode && typeof MutationObserver === "undefined") {
            var GlobalSetImmediate = global.setImmediate;
            var ProcessNextTick = process.nextTick;
            schedule = util.isRecentNode ? function(fn) {
              GlobalSetImmediate.call(global, fn);
            } : function(fn) {
              ProcessNextTick.call(process, fn);
            };
          } else if ((typeof MutationObserver !== "undefined") && !(typeof window !== "undefined" && window.navigator && window.navigator.standalone)) {
            schedule = (function() {
              var div = document.createElement("div");
              var opts = {attributes: true};
              var toggleScheduled = false;
              var div2 = document.createElement("div");
              var o2 = new MutationObserver(function() {
                div.classList.toggle("foo");
                toggleScheduled = false;
              });
              o2.observe(div2, opts);
              var scheduleToggle = function() {
                if (toggleScheduled)
                  return;
                toggleScheduled = true;
                div2.classList.toggle("foo");
              };
              return function schedule(fn) {
                var o = new MutationObserver(function() {
                  o.disconnect();
                  fn();
                });
                o.observe(div, opts);
                scheduleToggle();
              };
            })();
          } else if (typeof setImmediate !== "undefined") {
            schedule = function(fn) {
              setImmediate(fn);
            };
          } else if (typeof setTimeout !== "undefined") {
            schedule = function(fn) {
              setTimeout(fn, 0);
            };
          } else {
            schedule = noAsyncScheduler;
          }
          module.exports = schedule;
        }, {"./util": 36}],
        30: [function(_dereq_, module, exports) {
          "use strict";
          module.exports = function(Promise, PromiseArray, debug) {
            var PromiseInspection = Promise.PromiseInspection;
            var util = _dereq_("./util");
            function SettledPromiseArray(values) {
              this.constructor$(values);
            }
            util.inherits(SettledPromiseArray, PromiseArray);
            SettledPromiseArray.prototype._promiseResolved = function(index, inspection) {
              this._values[index] = inspection;
              var totalResolved = ++this._totalResolved;
              if (totalResolved >= this._length) {
                this._resolve(this._values);
                return true;
              }
              return false;
            };
            SettledPromiseArray.prototype._promiseFulfilled = function(value, index) {
              var ret = new PromiseInspection();
              ret._bitField = 33554432;
              ret._settledValueField = value;
              return this._promiseResolved(index, ret);
            };
            SettledPromiseArray.prototype._promiseRejected = function(reason, index) {
              var ret = new PromiseInspection();
              ret._bitField = 16777216;
              ret._settledValueField = reason;
              return this._promiseResolved(index, ret);
            };
            Promise.settle = function(promises) {
              debug.deprecated(".settle()", ".reflect()");
              return new SettledPromiseArray(promises).promise();
            };
            Promise.prototype.settle = function() {
              return Promise.settle(this);
            };
          };
        }, {"./util": 36}],
        31: [function(_dereq_, module, exports) {
          "use strict";
          module.exports = function(Promise, PromiseArray, apiRejection) {
            var util = _dereq_("./util");
            var RangeError = _dereq_("./errors").RangeError;
            var AggregateError = _dereq_("./errors").AggregateError;
            var isArray = util.isArray;
            var CANCELLATION = {};
            function SomePromiseArray(values) {
              this.constructor$(values);
              this._howMany = 0;
              this._unwrap = false;
              this._initialized = false;
            }
            util.inherits(SomePromiseArray, PromiseArray);
            SomePromiseArray.prototype._init = function() {
              if (!this._initialized) {
                return;
              }
              if (this._howMany === 0) {
                this._resolve([]);
                return;
              }
              this._init$(undefined, -5);
              var isArrayResolved = isArray(this._values);
              if (!this._isResolved() && isArrayResolved && this._howMany > this._canPossiblyFulfill()) {
                this._reject(this._getRangeError(this.length()));
              }
            };
            SomePromiseArray.prototype.init = function() {
              this._initialized = true;
              this._init();
            };
            SomePromiseArray.prototype.setUnwrap = function() {
              this._unwrap = true;
            };
            SomePromiseArray.prototype.howMany = function() {
              return this._howMany;
            };
            SomePromiseArray.prototype.setHowMany = function(count) {
              this._howMany = count;
            };
            SomePromiseArray.prototype._promiseFulfilled = function(value) {
              this._addFulfilled(value);
              if (this._fulfilled() === this.howMany()) {
                this._values.length = this.howMany();
                if (this.howMany() === 1 && this._unwrap) {
                  this._resolve(this._values[0]);
                } else {
                  this._resolve(this._values);
                }
                return true;
              }
              return false;
            };
            SomePromiseArray.prototype._promiseRejected = function(reason) {
              this._addRejected(reason);
              return this._checkOutcome();
            };
            SomePromiseArray.prototype._promiseCancelled = function() {
              if (this._values instanceof Promise || this._values == null) {
                return this._cancel();
              }
              this._addRejected(CANCELLATION);
              return this._checkOutcome();
            };
            SomePromiseArray.prototype._checkOutcome = function() {
              if (this.howMany() > this._canPossiblyFulfill()) {
                var e = new AggregateError();
                for (var i = this.length(); i < this._values.length; ++i) {
                  if (this._values[i] !== CANCELLATION) {
                    e.push(this._values[i]);
                  }
                }
                if (e.length > 0) {
                  this._reject(e);
                } else {
                  this._cancel();
                }
                return true;
              }
              return false;
            };
            SomePromiseArray.prototype._fulfilled = function() {
              return this._totalResolved;
            };
            SomePromiseArray.prototype._rejected = function() {
              return this._values.length - this.length();
            };
            SomePromiseArray.prototype._addRejected = function(reason) {
              this._values.push(reason);
            };
            SomePromiseArray.prototype._addFulfilled = function(value) {
              this._values[this._totalResolved++] = value;
            };
            SomePromiseArray.prototype._canPossiblyFulfill = function() {
              return this.length() - this._rejected();
            };
            SomePromiseArray.prototype._getRangeError = function(count) {
              var message = "Input array must contain at least " + this._howMany + " items but contains only " + count + " items";
              return new RangeError(message);
            };
            SomePromiseArray.prototype._resolveEmptyArray = function() {
              this._reject(this._getRangeError(0));
            };
            function some(promises, howMany) {
              if ((howMany | 0) !== howMany || howMany < 0) {
                return apiRejection("expecting a positive integer\u000a\u000a    See http://goo.gl/MqrFmX\u000a");
              }
              var ret = new SomePromiseArray(promises);
              var promise = ret.promise();
              ret.setHowMany(howMany);
              ret.init();
              return promise;
            }
            Promise.some = function(promises, howMany) {
              return some(promises, howMany);
            };
            Promise.prototype.some = function(howMany) {
              return some(this, howMany);
            };
            Promise._SomePromiseArray = SomePromiseArray;
          };
        }, {
          "./errors": 12,
          "./util": 36
        }],
        32: [function(_dereq_, module, exports) {
          "use strict";
          module.exports = function(Promise) {
            function PromiseInspection(promise) {
              if (promise !== undefined) {
                promise = promise._target();
                this._bitField = promise._bitField;
                this._settledValueField = promise._isFateSealed() ? promise._settledValue() : undefined;
              } else {
                this._bitField = 0;
                this._settledValueField = undefined;
              }
            }
            PromiseInspection.prototype._settledValue = function() {
              return this._settledValueField;
            };
            var value = PromiseInspection.prototype.value = function() {
              if (!this.isFulfilled()) {
                throw new TypeError("cannot get fulfillment value of a non-fulfilled promise\u000a\u000a    See http://goo.gl/MqrFmX\u000a");
              }
              return this._settledValue();
            };
            var reason = PromiseInspection.prototype.error = PromiseInspection.prototype.reason = function() {
              if (!this.isRejected()) {
                throw new TypeError("cannot get rejection reason of a non-rejected promise\u000a\u000a    See http://goo.gl/MqrFmX\u000a");
              }
              return this._settledValue();
            };
            var isFulfilled = PromiseInspection.prototype.isFulfilled = function() {
              return (this._bitField & 33554432) !== 0;
            };
            var isRejected = PromiseInspection.prototype.isRejected = function() {
              return (this._bitField & 16777216) !== 0;
            };
            var isPending = PromiseInspection.prototype.isPending = function() {
              return (this._bitField & 50397184) === 0;
            };
            var isResolved = PromiseInspection.prototype.isResolved = function() {
              return (this._bitField & 50331648) !== 0;
            };
            PromiseInspection.prototype.isCancelled = Promise.prototype._isCancelled = function() {
              return (this._bitField & 65536) === 65536;
            };
            Promise.prototype.isCancelled = function() {
              return this._target()._isCancelled();
            };
            Promise.prototype.isPending = function() {
              return isPending.call(this._target());
            };
            Promise.prototype.isRejected = function() {
              return isRejected.call(this._target());
            };
            Promise.prototype.isFulfilled = function() {
              return isFulfilled.call(this._target());
            };
            Promise.prototype.isResolved = function() {
              return isResolved.call(this._target());
            };
            Promise.prototype.value = function() {
              return value.call(this._target());
            };
            Promise.prototype.reason = function() {
              var target = this._target();
              target._unsetRejectionIsUnhandled();
              return reason.call(target);
            };
            Promise.prototype._value = function() {
              return this._settledValue();
            };
            Promise.prototype._reason = function() {
              this._unsetRejectionIsUnhandled();
              return this._settledValue();
            };
            Promise.PromiseInspection = PromiseInspection;
          };
        }, {}],
        33: [function(_dereq_, module, exports) {
          "use strict";
          module.exports = function(Promise, INTERNAL) {
            var util = _dereq_("./util");
            var errorObj = util.errorObj;
            var isObject = util.isObject;
            function tryConvertToPromise(obj, context) {
              if (isObject(obj)) {
                if (obj instanceof Promise)
                  return obj;
                var then = getThen(obj);
                if (then === errorObj) {
                  if (context)
                    context._pushContext();
                  var ret = Promise.reject(then.e);
                  if (context)
                    context._popContext();
                  return ret;
                } else if (typeof then === "function") {
                  if (isAnyBluebirdPromise(obj)) {
                    var ret = new Promise(INTERNAL);
                    obj._then(ret._fulfill, ret._reject, undefined, ret, null);
                    return ret;
                  }
                  return doThenable(obj, then, context);
                }
              }
              return obj;
            }
            function doGetThen(obj) {
              return obj.then;
            }
            function getThen(obj) {
              try {
                return doGetThen(obj);
              } catch (e) {
                errorObj.e = e;
                return errorObj;
              }
            }
            var hasProp = {}.hasOwnProperty;
            function isAnyBluebirdPromise(obj) {
              return hasProp.call(obj, "_promise0");
            }
            function doThenable(x, then, context) {
              var promise = new Promise(INTERNAL);
              var ret = promise;
              if (context)
                context._pushContext();
              promise._captureStackTrace();
              if (context)
                context._popContext();
              var synchronous = true;
              var result = util.tryCatch(then).call(x, resolve, reject);
              synchronous = false;
              if (promise && result === errorObj) {
                promise._rejectCallback(result.e, true, true);
                promise = null;
              }
              function resolve(value) {
                if (!promise)
                  return;
                promise._resolveCallback(value);
                promise = null;
              }
              function reject(reason) {
                if (!promise)
                  return;
                promise._rejectCallback(reason, synchronous, true);
                promise = null;
              }
              return ret;
            }
            return tryConvertToPromise;
          };
        }, {"./util": 36}],
        34: [function(_dereq_, module, exports) {
          "use strict";
          module.exports = function(Promise, INTERNAL) {
            var util = _dereq_("./util");
            var TimeoutError = Promise.TimeoutError;
            var afterTimeout = function(promise, message, parent) {
              if (!promise.isPending())
                return;
              var err;
              if (typeof message !== "string") {
                if (message instanceof Error) {
                  err = message;
                } else {
                  err = new TimeoutError("operation timed out");
                }
              } else {
                err = new TimeoutError(message);
              }
              util.markAsOriginatingFromRejection(err);
              promise._attachExtraTrace(err);
              promise._reject(err);
              parent.cancel();
            };
            var afterValue = function(value) {
              return delay(+this).thenReturn(value);
            };
            var delay = Promise.delay = function(ms, value) {
              var ret;
              if (value !== undefined) {
                ret = Promise.resolve(value)._then(afterValue, null, null, ms, undefined);
              } else {
                ret = new Promise(INTERNAL);
                setTimeout(function() {
                  ret._fulfill();
                }, +ms);
              }
              ret._setAsyncGuaranteed();
              return ret;
            };
            Promise.prototype.delay = function(ms) {
              return delay(ms, this);
            };
            function successClear(value) {
              var handle = this;
              if (handle instanceof Number)
                handle = +handle;
              clearTimeout(handle);
              return value;
            }
            function failureClear(reason) {
              var handle = this;
              if (handle instanceof Number)
                handle = +handle;
              clearTimeout(handle);
              throw reason;
            }
            Promise.prototype.timeout = function(ms, message) {
              ms = +ms;
              var parent = this.then();
              var ret = parent.then();
              var handle = setTimeout(function timeoutTimeout() {
                afterTimeout(ret, message, parent);
              }, ms);
              return ret._then(successClear, failureClear, undefined, handle, undefined);
            };
          };
        }, {"./util": 36}],
        35: [function(_dereq_, module, exports) {
          "use strict";
          module.exports = function(Promise, apiRejection, tryConvertToPromise, createContext, INTERNAL, debug) {
            var util = _dereq_("./util");
            var TypeError = _dereq_("./errors").TypeError;
            var inherits = _dereq_("./util").inherits;
            var errorObj = util.errorObj;
            var tryCatch = util.tryCatch;
            function thrower(e) {
              setTimeout(function() {
                throw e;
              }, 0);
            }
            function castPreservingDisposable(thenable) {
              var maybePromise = tryConvertToPromise(thenable);
              if (maybePromise !== thenable && typeof thenable._isDisposable === "function" && typeof thenable._getDisposer === "function" && thenable._isDisposable()) {
                maybePromise._setDisposable(thenable._getDisposer());
              }
              return maybePromise;
            }
            function dispose(resources, inspection) {
              var i = 0;
              var len = resources.length;
              var ret = new Promise(INTERNAL);
              function iterator() {
                if (i >= len)
                  return ret._fulfill();
                var maybePromise = castPreservingDisposable(resources[i++]);
                if (maybePromise instanceof Promise && maybePromise._isDisposable()) {
                  try {
                    maybePromise = tryConvertToPromise(maybePromise._getDisposer().tryDispose(inspection), resources.promise);
                  } catch (e) {
                    return thrower(e);
                  }
                  if (maybePromise instanceof Promise) {
                    return maybePromise._then(iterator, thrower, null, null, null);
                  }
                }
                iterator();
              }
              iterator();
              return ret;
            }
            function Disposer(data, promise, context) {
              this._data = data;
              this._promise = promise;
              this._context = context;
            }
            Disposer.prototype.data = function() {
              return this._data;
            };
            Disposer.prototype.promise = function() {
              return this._promise;
            };
            Disposer.prototype.resource = function() {
              if (this.promise().isFulfilled()) {
                return this.promise().value();
              }
              return null;
            };
            Disposer.prototype.tryDispose = function(inspection) {
              var resource = this.resource();
              var context = this._context;
              if (context !== undefined)
                context._pushContext();
              var ret = resource !== null ? this.doDispose(resource, inspection) : null;
              if (context !== undefined)
                context._popContext();
              this._promise._unsetDisposable();
              this._data = null;
              return ret;
            };
            Disposer.isDisposer = function(d) {
              return (d != null && typeof d.resource === "function" && typeof d.tryDispose === "function");
            };
            function FunctionDisposer(fn, promise, context) {
              this.constructor$(fn, promise, context);
            }
            inherits(FunctionDisposer, Disposer);
            FunctionDisposer.prototype.doDispose = function(resource, inspection) {
              var fn = this.data();
              return fn.call(resource, resource, inspection);
            };
            function maybeUnwrapDisposer(value) {
              if (Disposer.isDisposer(value)) {
                this.resources[this.index]._setDisposable(value);
                return value.promise();
              }
              return value;
            }
            function ResourceList(length) {
              this.length = length;
              this.promise = null;
              this[length - 1] = null;
            }
            ResourceList.prototype._resultCancelled = function() {
              var len = this.length;
              for (var i = 0; i < len; ++i) {
                var item = this[i];
                if (item instanceof Promise) {
                  item.cancel();
                }
              }
            };
            Promise.using = function() {
              var len = arguments.length;
              if (len < 2)
                return apiRejection("you must pass at least 2 arguments to Promise.using");
              var fn = arguments[len - 1];
              if (typeof fn !== "function") {
                return apiRejection("expecting a function but got " + util.classString(fn));
              }
              var input;
              var spreadArgs = true;
              if (len === 2 && Array.isArray(arguments[0])) {
                input = arguments[0];
                len = input.length;
                spreadArgs = false;
              } else {
                input = arguments;
                len--;
              }
              var resources = new ResourceList(len);
              for (var i = 0; i < len; ++i) {
                var resource = input[i];
                if (Disposer.isDisposer(resource)) {
                  var disposer = resource;
                  resource = resource.promise();
                  resource._setDisposable(disposer);
                } else {
                  var maybePromise = tryConvertToPromise(resource);
                  if (maybePromise instanceof Promise) {
                    resource = maybePromise._then(maybeUnwrapDisposer, null, null, {
                      resources: resources,
                      index: i
                    }, undefined);
                  }
                }
                resources[i] = resource;
              }
              var reflectedResources = new Array(resources.length);
              for (var i = 0; i < reflectedResources.length; ++i) {
                reflectedResources[i] = Promise.resolve(resources[i]).reflect();
              }
              var resultPromise = Promise.all(reflectedResources).then(function(inspections) {
                for (var i = 0; i < inspections.length; ++i) {
                  var inspection = inspections[i];
                  if (inspection.isRejected()) {
                    errorObj.e = inspection.error();
                    return errorObj;
                  } else if (!inspection.isFulfilled()) {
                    resultPromise.cancel();
                    return;
                  }
                  inspections[i] = inspection.value();
                }
                promise._pushContext();
                fn = tryCatch(fn);
                var ret = spreadArgs ? fn.apply(undefined, inspections) : fn(inspections);
                var promiseCreated = promise._popContext();
                debug.checkForgottenReturns(ret, promiseCreated, "Promise.using", promise);
                return ret;
              });
              var promise = resultPromise.lastly(function() {
                var inspection = new Promise.PromiseInspection(resultPromise);
                return dispose(resources, inspection);
              });
              resources.promise = promise;
              promise._setOnCancel(resources);
              return promise;
            };
            Promise.prototype._setDisposable = function(disposer) {
              this._bitField = this._bitField | 131072;
              this._disposer = disposer;
            };
            Promise.prototype._isDisposable = function() {
              return (this._bitField & 131072) > 0;
            };
            Promise.prototype._getDisposer = function() {
              return this._disposer;
            };
            Promise.prototype._unsetDisposable = function() {
              this._bitField = this._bitField & (~131072);
              this._disposer = undefined;
            };
            Promise.prototype.disposer = function(fn) {
              if (typeof fn === "function") {
                return new FunctionDisposer(fn, this, createContext());
              }
              throw new TypeError();
            };
          };
        }, {
          "./errors": 12,
          "./util": 36
        }],
        36: [function(_dereq_, module, exports) {
          "use strict";
          var es5 = _dereq_("./es5");
          var canEvaluate = typeof navigator == "undefined";
          var errorObj = {e: {}};
          var tryCatchTarget;
          function tryCatcher() {
            try {
              var target = tryCatchTarget;
              tryCatchTarget = null;
              return target.apply(this, arguments);
            } catch (e) {
              errorObj.e = e;
              return errorObj;
            }
          }
          function tryCatch(fn) {
            tryCatchTarget = fn;
            return tryCatcher;
          }
          var inherits = function(Child, Parent) {
            var hasProp = {}.hasOwnProperty;
            function T() {
              this.constructor = Child;
              this.constructor$ = Parent;
              for (var propertyName in Parent.prototype) {
                if (hasProp.call(Parent.prototype, propertyName) && propertyName.charAt(propertyName.length - 1) !== "$") {
                  this[propertyName + "$"] = Parent.prototype[propertyName];
                }
              }
            }
            T.prototype = Parent.prototype;
            Child.prototype = new T();
            return Child.prototype;
          };
          function isPrimitive(val) {
            return val == null || val === true || val === false || typeof val === "string" || typeof val === "number";
          }
          function isObject(value) {
            return typeof value === "function" || typeof value === "object" && value !== null;
          }
          function maybeWrapAsError(maybeError) {
            if (!isPrimitive(maybeError))
              return maybeError;
            return new Error(safeToString(maybeError));
          }
          function withAppended(target, appendee) {
            var len = target.length;
            var ret = new Array(len + 1);
            var i;
            for (i = 0; i < len; ++i) {
              ret[i] = target[i];
            }
            ret[i] = appendee;
            return ret;
          }
          function getDataPropertyOrDefault(obj, key, defaultValue) {
            if (es5.isES5) {
              var desc = Object.getOwnPropertyDescriptor(obj, key);
              if (desc != null) {
                return desc.get == null && desc.set == null ? desc.value : defaultValue;
              }
            } else {
              return {}.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
            }
          }
          function notEnumerableProp(obj, name, value) {
            if (isPrimitive(obj))
              return obj;
            var descriptor = {
              value: value,
              configurable: true,
              enumerable: false,
              writable: true
            };
            es5.defineProperty(obj, name, descriptor);
            return obj;
          }
          function thrower(r) {
            throw r;
          }
          var inheritedDataKeys = (function() {
            var excludedPrototypes = [Array.prototype, Object.prototype, Function.prototype];
            var isExcludedProto = function(val) {
              for (var i = 0; i < excludedPrototypes.length; ++i) {
                if (excludedPrototypes[i] === val) {
                  return true;
                }
              }
              return false;
            };
            if (es5.isES5) {
              var getKeys = Object.getOwnPropertyNames;
              return function(obj) {
                var ret = [];
                var visitedKeys = Object.create(null);
                while (obj != null && !isExcludedProto(obj)) {
                  var keys;
                  try {
                    keys = getKeys(obj);
                  } catch (e) {
                    return ret;
                  }
                  for (var i = 0; i < keys.length; ++i) {
                    var key = keys[i];
                    if (visitedKeys[key])
                      continue;
                    visitedKeys[key] = true;
                    var desc = Object.getOwnPropertyDescriptor(obj, key);
                    if (desc != null && desc.get == null && desc.set == null) {
                      ret.push(key);
                    }
                  }
                  obj = es5.getPrototypeOf(obj);
                }
                return ret;
              };
            } else {
              var hasProp = {}.hasOwnProperty;
              return function(obj) {
                if (isExcludedProto(obj))
                  return [];
                var ret = [];
                enumeration: for (var key in obj) {
                  if (hasProp.call(obj, key)) {
                    ret.push(key);
                  } else {
                    for (var i = 0; i < excludedPrototypes.length; ++i) {
                      if (hasProp.call(excludedPrototypes[i], key)) {
                        continue enumeration;
                      }
                    }
                    ret.push(key);
                  }
                }
                return ret;
              };
            }
          })();
          var thisAssignmentPattern = /this\s*\.\s*\S+\s*=/;
          function isClass(fn) {
            try {
              if (typeof fn === "function") {
                var keys = es5.names(fn.prototype);
                var hasMethods = es5.isES5 && keys.length > 1;
                var hasMethodsOtherThanConstructor = keys.length > 0 && !(keys.length === 1 && keys[0] === "constructor");
                var hasThisAssignmentAndStaticMethods = thisAssignmentPattern.test(fn + "") && es5.names(fn).length > 0;
                if (hasMethods || hasMethodsOtherThanConstructor || hasThisAssignmentAndStaticMethods) {
                  return true;
                }
              }
              return false;
            } catch (e) {
              return false;
            }
          }
          function toFastProperties(obj) {
            function FakeConstructor() {}
            FakeConstructor.prototype = obj;
            var l = 8;
            while (l--)
              new FakeConstructor();
            return obj;
            eval(obj);
          }
          var rident = /^[a-z$_][a-z$_0-9]*$/i;
          function isIdentifier(str) {
            return rident.test(str);
          }
          function filledRange(count, prefix, suffix) {
            var ret = new Array(count);
            for (var i = 0; i < count; ++i) {
              ret[i] = prefix + i + suffix;
            }
            return ret;
          }
          function safeToString(obj) {
            try {
              return obj + "";
            } catch (e) {
              return "[no string representation]";
            }
          }
          function markAsOriginatingFromRejection(e) {
            try {
              notEnumerableProp(e, "isOperational", true);
            } catch (ignore) {}
          }
          function originatesFromRejection(e) {
            if (e == null)
              return false;
            return ((e instanceof Error["__BluebirdErrorTypes__"].OperationalError) || e["isOperational"] === true);
          }
          function canAttachTrace(obj) {
            return obj instanceof Error && es5.propertyIsWritable(obj, "stack");
          }
          var ensureErrorObject = (function() {
            if (!("stack" in new Error())) {
              return function(value) {
                if (canAttachTrace(value))
                  return value;
                try {
                  throw new Error(safeToString(value));
                } catch (err) {
                  return err;
                }
              };
            } else {
              return function(value) {
                if (canAttachTrace(value))
                  return value;
                return new Error(safeToString(value));
              };
            }
          })();
          function classString(obj) {
            return {}.toString.call(obj);
          }
          function copyDescriptors(from, to, filter) {
            var keys = es5.names(from);
            for (var i = 0; i < keys.length; ++i) {
              var key = keys[i];
              if (filter(key)) {
                try {
                  es5.defineProperty(to, key, es5.getDescriptor(from, key));
                } catch (ignore) {}
              }
            }
          }
          var asArray = function(v) {
            if (es5.isArray(v)) {
              return v;
            }
            return null;
          };
          if (typeof Symbol !== "undefined" && Symbol.iterator) {
            var ArrayFrom = typeof Array.from === "function" ? function(v) {
              return Array.from(v);
            } : function(v) {
              var ret = [];
              var it = v[Symbol.iterator]();
              var itResult;
              while (!((itResult = it.next()).done)) {
                ret.push(itResult.value);
              }
              return ret;
            };
            asArray = function(v) {
              if (es5.isArray(v)) {
                return v;
              } else if (v != null && typeof v[Symbol.iterator] === "function") {
                return ArrayFrom(v);
              }
              return null;
            };
          }
          var isNode = typeof process !== "undefined" && classString(process).toLowerCase() === "[object process]";
          function env(key, def) {
            return isNode ? process.env[key] : def;
          }
          var ret = {
            isClass: isClass,
            isIdentifier: isIdentifier,
            inheritedDataKeys: inheritedDataKeys,
            getDataPropertyOrDefault: getDataPropertyOrDefault,
            thrower: thrower,
            isArray: es5.isArray,
            asArray: asArray,
            notEnumerableProp: notEnumerableProp,
            isPrimitive: isPrimitive,
            isObject: isObject,
            canEvaluate: canEvaluate,
            errorObj: errorObj,
            tryCatch: tryCatch,
            inherits: inherits,
            withAppended: withAppended,
            maybeWrapAsError: maybeWrapAsError,
            toFastProperties: toFastProperties,
            filledRange: filledRange,
            toString: safeToString,
            canAttachTrace: canAttachTrace,
            ensureErrorObject: ensureErrorObject,
            originatesFromRejection: originatesFromRejection,
            markAsOriginatingFromRejection: markAsOriginatingFromRejection,
            classString: classString,
            copyDescriptors: copyDescriptors,
            hasDevTools: typeof chrome !== "undefined" && chrome && typeof chrome.loadTimes === "function",
            isNode: isNode,
            env: env
          };
          ret.isRecentNode = ret.isNode && (function() {
            var version = process.versions.node.split(".").map(Number);
            return (version[0] === 0 && version[1] > 10) || (version[0] > 0);
          })();
          if (ret.isNode)
            ret.toFastProperties(process);
          try {
            throw new Error();
          } catch (e) {
            ret.lastLineError = e;
          }
          module.exports = ret;
        }, {"./es5": 13}]
      }, {}, [4])(4);
    });
    ;
    if (typeof window !== 'undefined' && window !== null) {
      window.P = window.Promise;
    } else if (typeof self !== 'undefined' && self !== null) {
      self.P = self.Promise;
    }
  })(req('7'));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("9", ["8"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = req('8');
  global.define = __define;
  return module.exports;
});

$__System.register("a", ["9"], function (_export) {
	"use strict";

	var Promise;
	return {
		setters: [function (_) {
			Promise = _["default"];
		}],
		execute: function () {
			_export("default", function (vm, ws_url) {

				Promise.onPossiblyUnhandledRejection(function (error) {
					vm.error = error;
				});

				var buffer = [];
				var last_request_id = 1;
				var requests = {};

				vm.$set("connected", false);

				var ws = new WebSocket(ws_url);

				ws.rpc = function (method, args) {
					var request_id = last_request_id += 1;
					return new Promise(function (resolve, reject) {
						if (resolve) requests[request_id] = { success: resolve, error: reject };
						var msg = JSON.stringify({
							request_id: request_id,
							method: method,
							args: args || {}
						});
						if (vm.connected) {
							ws.send(msg);
						} else {
							buffer.push(msg);
						}
					});
				};

				ws.onopen = function () {
					vm.connected = true;
					buffer.forEach(function (msg) {
						ws.send(msg);
					});
				};

				ws.onmessage = function (evt) {
					var data = JSON.parse(evt.data);
					var message = JSON.stringify(data, null, 4);
					if (data.response_id) {
						if (data.error) requests[data.response_id].error(new Error(data.error));else requests[data.response_id].success(data.result);
						delete requests[data.response_id];
					} else {
						vm.$emit(data.signal, data.message);
					}
				};

				ws.onclose = function () {
					vm.connected = false;
				};

				return ws;
			});
		}
	};
});
$__System.registerDynamic("b", ["7"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    function set(obj, key, val) {
      if (hasOwn(obj, key)) {
        obj[key] = val;
        return;
      }
      if (obj._isVue) {
        set(obj._data, key, val);
        return;
      }
      var ob = obj.__ob__;
      if (!ob) {
        obj[key] = val;
        return;
      }
      ob.convert(key, val);
      ob.dep.notify();
      if (ob.vms) {
        var i = ob.vms.length;
        while (i--) {
          var vm = ob.vms[i];
          vm._proxy(key);
          vm._digest();
        }
      }
      return val;
    }
    function del(obj, key) {
      if (!hasOwn(obj, key)) {
        return;
      }
      delete obj[key];
      var ob = obj.__ob__;
      if (!ob) {
        return;
      }
      ob.dep.notify();
      if (ob.vms) {
        var i = ob.vms.length;
        while (i--) {
          var vm = ob.vms[i];
          vm._unproxy(key);
          vm._digest();
        }
      }
    }
    var hasOwnProperty = Object.prototype.hasOwnProperty;
    function hasOwn(obj, key) {
      return hasOwnProperty.call(obj, key);
    }
    var literalValueRE = /^\s?(true|false|[\d\.]+|'[^']*'|"[^"]*")\s?$/;
    function isLiteral(exp) {
      return literalValueRE.test(exp);
    }
    function isReserved(str) {
      var c = (str + '').charCodeAt(0);
      return c === 0x24 || c === 0x5F;
    }
    function _toString(value) {
      return value == null ? '' : value.toString();
    }
    function toNumber(value) {
      if (typeof value !== 'string') {
        return value;
      } else {
        var parsed = Number(value);
        return isNaN(parsed) ? value : parsed;
      }
    }
    function toBoolean(value) {
      return value === 'true' ? true : value === 'false' ? false : value;
    }
    function stripQuotes(str) {
      var a = str.charCodeAt(0);
      var b = str.charCodeAt(str.length - 1);
      return a === b && (a === 0x22 || a === 0x27) ? str.slice(1, -1) : str;
    }
    var camelizeRE = /-(\w)/g;
    function camelize(str) {
      return str.replace(camelizeRE, toUpper);
    }
    function toUpper(_, c) {
      return c ? c.toUpperCase() : '';
    }
    var hyphenateRE = /([a-z\d])([A-Z])/g;
    function hyphenate(str) {
      return str.replace(hyphenateRE, '$1-$2').toLowerCase();
    }
    var classifyRE = /(?:^|[-_\/])(\w)/g;
    function classify(str) {
      return str.replace(classifyRE, toUpper);
    }
    function bind$1(fn, ctx) {
      return function(a) {
        var l = arguments.length;
        return l ? l > 1 ? fn.apply(ctx, arguments) : fn.call(ctx, a) : fn.call(ctx);
      };
    }
    function toArray(list, start) {
      start = start || 0;
      var i = list.length - start;
      var ret = new Array(i);
      while (i--) {
        ret[i] = list[i + start];
      }
      return ret;
    }
    function extend(to, from) {
      var keys = Object.keys(from);
      var i = keys.length;
      while (i--) {
        to[keys[i]] = from[keys[i]];
      }
      return to;
    }
    function isObject(obj) {
      return obj !== null && typeof obj === 'object';
    }
    var toString = Object.prototype.toString;
    var OBJECT_STRING = '[object Object]';
    function isPlainObject(obj) {
      return toString.call(obj) === OBJECT_STRING;
    }
    var isArray = Array.isArray;
    function def(obj, key, val, enumerable) {
      Object.defineProperty(obj, key, {
        value: val,
        enumerable: !!enumerable,
        writable: true,
        configurable: true
      });
    }
    function _debounce(func, wait) {
      var timeout,
          args,
          context,
          timestamp,
          result;
      var later = function later() {
        var last = Date.now() - timestamp;
        if (last < wait && last >= 0) {
          timeout = setTimeout(later, wait - last);
        } else {
          timeout = null;
          result = func.apply(context, args);
          if (!timeout)
            context = args = null;
        }
      };
      return function() {
        context = this;
        args = arguments;
        timestamp = Date.now();
        if (!timeout) {
          timeout = setTimeout(later, wait);
        }
        return result;
      };
    }
    function indexOf(arr, obj) {
      var i = arr.length;
      while (i--) {
        if (arr[i] === obj)
          return i;
      }
      return -1;
    }
    function cancellable(fn) {
      var cb = function cb() {
        if (!cb.cancelled) {
          return fn.apply(this, arguments);
        }
      };
      cb.cancel = function() {
        cb.cancelled = true;
      };
      return cb;
    }
    function looseEqual(a, b) {
      return a == b || (isObject(a) && isObject(b) ? JSON.stringify(a) === JSON.stringify(b) : false);
    }
    var hasProto = ('__proto__' in {});
    var inBrowser = typeof window !== 'undefined' && Object.prototype.toString.call(window) !== '[object Object]';
    var isIE9 = inBrowser && navigator.userAgent.toLowerCase().indexOf('msie 9.0') > 0;
    var isAndroid = inBrowser && navigator.userAgent.toLowerCase().indexOf('android') > 0;
    var transitionProp = undefined;
    var transitionEndEvent = undefined;
    var animationProp = undefined;
    var animationEndEvent = undefined;
    if (inBrowser && !isIE9) {
      var isWebkitTrans = window.ontransitionend === undefined && window.onwebkittransitionend !== undefined;
      var isWebkitAnim = window.onanimationend === undefined && window.onwebkitanimationend !== undefined;
      transitionProp = isWebkitTrans ? 'WebkitTransition' : 'transition';
      transitionEndEvent = isWebkitTrans ? 'webkitTransitionEnd' : 'transitionend';
      animationProp = isWebkitAnim ? 'WebkitAnimation' : 'animation';
      animationEndEvent = isWebkitAnim ? 'webkitAnimationEnd' : 'animationend';
    }
    var nextTick = (function() {
      var callbacks = [];
      var pending = false;
      var timerFunc;
      function nextTickHandler() {
        pending = false;
        var copies = callbacks.slice(0);
        callbacks = [];
        for (var i = 0; i < copies.length; i++) {
          copies[i]();
        }
      }
      if (typeof MutationObserver !== 'undefined') {
        var counter = 1;
        var observer = new MutationObserver(nextTickHandler);
        var textNode = document.createTextNode(counter);
        observer.observe(textNode, {characterData: true});
        timerFunc = function() {
          counter = (counter + 1) % 2;
          textNode.data = counter;
        };
      } else {
        timerFunc = setTimeout;
      }
      return function(cb, ctx) {
        var func = ctx ? function() {
          cb.call(ctx);
        } : cb;
        callbacks.push(func);
        if (pending)
          return;
        pending = true;
        timerFunc(nextTickHandler, 0);
      };
    })();
    function Cache(limit) {
      this.size = 0;
      this.limit = limit;
      this.head = this.tail = undefined;
      this._keymap = Object.create(null);
    }
    var p = Cache.prototype;
    p.put = function(key, value) {
      var entry = {
        key: key,
        value: value
      };
      this._keymap[key] = entry;
      if (this.tail) {
        this.tail.newer = entry;
        entry.older = this.tail;
      } else {
        this.head = entry;
      }
      this.tail = entry;
      if (this.size === this.limit) {
        return this.shift();
      } else {
        this.size++;
      }
    };
    p.shift = function() {
      var entry = this.head;
      if (entry) {
        this.head = this.head.newer;
        this.head.older = undefined;
        entry.newer = entry.older = undefined;
        this._keymap[entry.key] = undefined;
      }
      return entry;
    };
    p.get = function(key, returnEntry) {
      var entry = this._keymap[key];
      if (entry === undefined)
        return;
      if (entry === this.tail) {
        return returnEntry ? entry : entry.value;
      }
      if (entry.newer) {
        if (entry === this.head) {
          this.head = entry.newer;
        }
        entry.newer.older = entry.older;
      }
      if (entry.older) {
        entry.older.newer = entry.newer;
      }
      entry.newer = undefined;
      entry.older = this.tail;
      if (this.tail) {
        this.tail.newer = entry;
      }
      this.tail = entry;
      return returnEntry ? entry : entry.value;
    };
    var cache$1 = new Cache(1000);
    var filterTokenRE = /[^\s'"]+|'[^']*'|"[^"]*"/g;
    var reservedArgRE = /^in$|^-?\d+/;
    var str;
    var dir;
    var c;
    var prev;
    var i;
    var l;
    var lastFilterIndex;
    var inSingle;
    var inDouble;
    var curly;
    var square;
    var paren;
    function pushFilter() {
      var exp = str.slice(lastFilterIndex, i).trim();
      var filter;
      if (exp) {
        filter = {};
        var tokens = exp.match(filterTokenRE);
        filter.name = tokens[0];
        if (tokens.length > 1) {
          filter.args = tokens.slice(1).map(processFilterArg);
        }
      }
      if (filter) {
        (dir.filters = dir.filters || []).push(filter);
      }
      lastFilterIndex = i + 1;
    }
    function processFilterArg(arg) {
      if (reservedArgRE.test(arg)) {
        return {
          value: toNumber(arg),
          dynamic: false
        };
      } else {
        var stripped = stripQuotes(arg);
        var dynamic = stripped === arg;
        return {
          value: dynamic ? arg : stripped,
          dynamic: dynamic
        };
      }
    }
    function parseDirective(s) {
      var hit = cache$1.get(s);
      if (hit) {
        return hit;
      }
      str = s;
      inSingle = inDouble = false;
      curly = square = paren = 0;
      lastFilterIndex = 0;
      dir = {};
      for (i = 0, l = str.length; i < l; i++) {
        prev = c;
        c = str.charCodeAt(i);
        if (inSingle) {
          if (c === 0x27 && prev !== 0x5C)
            inSingle = !inSingle;
        } else if (inDouble) {
          if (c === 0x22 && prev !== 0x5C)
            inDouble = !inDouble;
        } else if (c === 0x7C && str.charCodeAt(i + 1) !== 0x7C && str.charCodeAt(i - 1) !== 0x7C) {
          if (dir.expression == null) {
            lastFilterIndex = i + 1;
            dir.expression = str.slice(0, i).trim();
          } else {
            pushFilter();
          }
        } else {
          switch (c) {
            case 0x22:
              inDouble = true;
              break;
            case 0x27:
              inSingle = true;
              break;
            case 0x28:
              paren++;
              break;
            case 0x29:
              paren--;
              break;
            case 0x5B:
              square++;
              break;
            case 0x5D:
              square--;
              break;
            case 0x7B:
              curly++;
              break;
            case 0x7D:
              curly--;
              break;
          }
        }
      }
      if (dir.expression == null) {
        dir.expression = str.slice(0, i).trim();
      } else if (lastFilterIndex !== 0) {
        pushFilter();
      }
      cache$1.put(s, dir);
      return dir;
    }
    var directive = Object.freeze({parseDirective: parseDirective});
    var regexEscapeRE = /[-.*+?^${}()|[\]\/\\]/g;
    var cache = undefined;
    var tagRE = undefined;
    var htmlRE = undefined;
    function escapeRegex(str) {
      return str.replace(regexEscapeRE, '\\$&');
    }
    function compileRegex() {
      var open = escapeRegex(config.delimiters[0]);
      var close = escapeRegex(config.delimiters[1]);
      var unsafeOpen = escapeRegex(config.unsafeDelimiters[0]);
      var unsafeClose = escapeRegex(config.unsafeDelimiters[1]);
      tagRE = new RegExp(unsafeOpen + '(.+?)' + unsafeClose + '|' + open + '(.+?)' + close, 'g');
      htmlRE = new RegExp('^' + unsafeOpen + '.*' + unsafeClose + '$');
      cache = new Cache(1000);
    }
    function parseText(text) {
      if (!cache) {
        compileRegex();
      }
      var hit = cache.get(text);
      if (hit) {
        return hit;
      }
      text = text.replace(/\n/g, '');
      if (!tagRE.test(text)) {
        return null;
      }
      var tokens = [];
      var lastIndex = tagRE.lastIndex = 0;
      var match,
          index,
          html,
          value,
          first,
          oneTime;
      while (match = tagRE.exec(text)) {
        index = match.index;
        if (index > lastIndex) {
          tokens.push({value: text.slice(lastIndex, index)});
        }
        html = htmlRE.test(match[0]);
        value = html ? match[1] : match[2];
        first = value.charCodeAt(0);
        oneTime = first === 42;
        value = oneTime ? value.slice(1) : value;
        tokens.push({
          tag: true,
          value: value.trim(),
          html: html,
          oneTime: oneTime
        });
        lastIndex = index + match[0].length;
      }
      if (lastIndex < text.length) {
        tokens.push({value: text.slice(lastIndex)});
      }
      cache.put(text, tokens);
      return tokens;
    }
    function tokensToExp(tokens) {
      if (tokens.length > 1) {
        return tokens.map(function(token) {
          return formatToken(token);
        }).join('+');
      } else {
        return formatToken(tokens[0], true);
      }
    }
    function formatToken(token, single) {
      return token.tag ? inlineFilters(token.value, single) : '"' + token.value + '"';
    }
    var filterRE$1 = /[^|]\|[^|]/;
    function inlineFilters(exp, single) {
      if (!filterRE$1.test(exp)) {
        return single ? exp : '(' + exp + ')';
      } else {
        var dir = parseDirective(exp);
        if (!dir.filters) {
          return '(' + exp + ')';
        } else {
          return 'this._applyFilters(' + dir.expression + ',null,' + JSON.stringify(dir.filters) + ',false)';
        }
      }
    }
    var text$1 = Object.freeze({
      compileRegex: compileRegex,
      parseText: parseText,
      tokensToExp: tokensToExp
    });
    var delimiters = ['{{', '}}'];
    var unsafeDelimiters = ['{{{', '}}}'];
    var config = Object.defineProperties({
      debug: false,
      silent: false,
      async: true,
      warnExpressionErrors: true,
      convertAllProperties: false,
      _delimitersChanged: true,
      _assetTypes: ['component', 'directive', 'elementDirective', 'filter', 'transition', 'partial'],
      _propBindingModes: {
        ONE_WAY: 0,
        TWO_WAY: 1,
        ONE_TIME: 2
      },
      _maxUpdateCount: 100
    }, {
      delimiters: {
        get: function get() {
          return delimiters;
        },
        set: function set(val) {
          delimiters = val;
          compileRegex();
        },
        configurable: true,
        enumerable: true
      },
      unsafeDelimiters: {
        get: function get() {
          return unsafeDelimiters;
        },
        set: function set(val) {
          unsafeDelimiters = val;
          compileRegex();
        },
        configurable: true,
        enumerable: true
      }
    });
    var warn = undefined;
    if (process.env.NODE_ENV !== 'production') {
      (function() {
        var hasConsole = typeof console !== 'undefined';
        warn = function(msg, e) {
          if (hasConsole && (!config.silent || config.debug)) {
            console.warn('[Vue warn]: ' + msg);
            if (config.debug) {
              if (e) {
                throw e;
              } else {
                console.warn(new Error('Warning Stack Trace').stack);
              }
            }
          }
        };
      })();
    }
    function appendWithTransition(el, target, vm, cb) {
      applyTransition(el, 1, function() {
        target.appendChild(el);
      }, vm, cb);
    }
    function beforeWithTransition(el, target, vm, cb) {
      applyTransition(el, 1, function() {
        before(el, target);
      }, vm, cb);
    }
    function removeWithTransition(el, vm, cb) {
      applyTransition(el, -1, function() {
        remove(el);
      }, vm, cb);
    }
    function applyTransition(el, direction, op, vm, cb) {
      var transition = el.__v_trans;
      if (!transition || !transition.hooks && !transitionEndEvent || !vm._isCompiled || vm.$parent && !vm.$parent._isCompiled) {
        op();
        if (cb)
          cb();
        return;
      }
      var action = direction > 0 ? 'enter' : 'leave';
      transition[action](op, cb);
    }
    function query(el) {
      if (typeof el === 'string') {
        var selector = el;
        el = document.querySelector(el);
        if (!el) {
          process.env.NODE_ENV !== 'production' && warn('Cannot find element: ' + selector);
        }
      }
      return el;
    }
    function inDoc(node) {
      var doc = document.documentElement;
      var parent = node && node.parentNode;
      return doc === node || doc === parent || !!(parent && parent.nodeType === 1 && doc.contains(parent));
    }
    function getAttr(node, _attr) {
      var val = node.getAttribute(_attr);
      if (val !== null) {
        node.removeAttribute(_attr);
      }
      return val;
    }
    function getBindAttr(node, name) {
      var val = getAttr(node, ':' + name);
      if (val === null) {
        val = getAttr(node, 'v-bind:' + name);
      }
      return val;
    }
    function hasBindAttr(node, name) {
      return node.hasAttribute(name) || node.hasAttribute(':' + name) || node.hasAttribute('v-bind:' + name);
    }
    function before(el, target) {
      target.parentNode.insertBefore(el, target);
    }
    function after(el, target) {
      if (target.nextSibling) {
        before(el, target.nextSibling);
      } else {
        target.parentNode.appendChild(el);
      }
    }
    function remove(el) {
      el.parentNode.removeChild(el);
    }
    function prepend(el, target) {
      if (target.firstChild) {
        before(el, target.firstChild);
      } else {
        target.appendChild(el);
      }
    }
    function replace(target, el) {
      var parent = target.parentNode;
      if (parent) {
        parent.replaceChild(el, target);
      }
    }
    function on$1(el, event, cb) {
      el.addEventListener(event, cb);
    }
    function off(el, event, cb) {
      el.removeEventListener(event, cb);
    }
    function setClass(el, cls) {
      if (isIE9 && !(el instanceof SVGElement)) {
        el.className = cls;
      } else {
        el.setAttribute('class', cls);
      }
    }
    function addClass(el, cls) {
      if (el.classList) {
        el.classList.add(cls);
      } else {
        var cur = ' ' + (el.getAttribute('class') || '') + ' ';
        if (cur.indexOf(' ' + cls + ' ') < 0) {
          setClass(el, (cur + cls).trim());
        }
      }
    }
    function removeClass(el, cls) {
      if (el.classList) {
        el.classList.remove(cls);
      } else {
        var cur = ' ' + (el.getAttribute('class') || '') + ' ';
        var tar = ' ' + cls + ' ';
        while (cur.indexOf(tar) >= 0) {
          cur = cur.replace(tar, ' ');
        }
        setClass(el, cur.trim());
      }
      if (!el.className) {
        el.removeAttribute('class');
      }
    }
    function extractContent(el, asFragment) {
      var child;
      var rawContent;
      if (isTemplate(el) && el.content instanceof DocumentFragment) {
        el = el.content;
      }
      if (el.hasChildNodes()) {
        trimNode(el);
        rawContent = asFragment ? document.createDocumentFragment() : document.createElement('div');
        while (child = el.firstChild) {
          rawContent.appendChild(child);
        }
      }
      return rawContent;
    }
    function trimNode(node) {
      trim(node, node.firstChild);
      trim(node, node.lastChild);
    }
    function trim(parent, node) {
      if (node && node.nodeType === 3 && !node.data.trim()) {
        parent.removeChild(node);
      }
    }
    function isTemplate(el) {
      return el.tagName && el.tagName.toLowerCase() === 'template';
    }
    function createAnchor(content, persist) {
      var anchor = config.debug ? document.createComment(content) : document.createTextNode(persist ? ' ' : '');
      anchor.__vue_anchor = true;
      return anchor;
    }
    var refRE = /^v-ref:/;
    function findRef(node) {
      if (node.hasAttributes()) {
        var attrs = node.attributes;
        for (var i = 0,
            l = attrs.length; i < l; i++) {
          var name = attrs[i].name;
          if (refRE.test(name)) {
            return camelize(name.replace(refRE, ''));
          }
        }
      }
    }
    function mapNodeRange(node, end, op) {
      var next;
      while (node !== end) {
        next = node.nextSibling;
        op(node);
        node = next;
      }
      op(end);
    }
    function removeNodeRange(start, end, vm, frag, cb) {
      var done = false;
      var removed = 0;
      var nodes = [];
      mapNodeRange(start, end, function(node) {
        if (node === end)
          done = true;
        nodes.push(node);
        removeWithTransition(node, vm, onRemoved);
      });
      function onRemoved() {
        removed++;
        if (done && removed >= nodes.length) {
          for (var i = 0; i < nodes.length; i++) {
            frag.appendChild(nodes[i]);
          }
          cb && cb();
        }
      }
    }
    var commonTagRE = /^(div|p|span|img|a|b|i|br|ul|ol|li|h1|h2|h3|h4|h5|h6|code|pre|table|th|td|tr|form|label|input|select|option|nav|article|section|header|footer)$/;
    var reservedTagRE = /^(slot|partial|component)$/;
    function checkComponentAttr(el, options) {
      var tag = el.tagName.toLowerCase();
      var hasAttrs = el.hasAttributes();
      if (!commonTagRE.test(tag) && !reservedTagRE.test(tag)) {
        if (resolveAsset(options, 'components', tag)) {
          return {id: tag};
        } else {
          var is = hasAttrs && getIsBinding(el);
          if (is) {
            return is;
          } else if (process.env.NODE_ENV !== 'production') {
            if (tag.indexOf('-') > -1 || /HTMLUnknownElement/.test(el.toString()) && !/^(data|time|rtc|rb)$/.test(tag)) {
              warn('Unknown custom element: <' + tag + '> - did you ' + 'register the component correctly?');
            }
          }
        }
      } else if (hasAttrs) {
        return getIsBinding(el);
      }
    }
    function getIsBinding(el) {
      var exp = getAttr(el, 'is');
      if (exp != null) {
        return {id: exp};
      } else {
        exp = getBindAttr(el, 'is');
        if (exp != null) {
          return {
            id: exp,
            dynamic: true
          };
        }
      }
    }
    function initProp(vm, prop, value) {
      var key = prop.path;
      value = coerceProp(prop, value);
      vm[key] = vm._data[key] = assertProp(prop, value) ? value : undefined;
    }
    function assertProp(prop, value) {
      if (prop.raw === null && !prop.required) {
        return true;
      }
      var options = prop.options;
      var type = options.type;
      var valid = true;
      var expectedType;
      if (type) {
        if (type === String) {
          expectedType = 'string';
          valid = typeof value === expectedType;
        } else if (type === Number) {
          expectedType = 'number';
          valid = typeof value === 'number';
        } else if (type === Boolean) {
          expectedType = 'boolean';
          valid = typeof value === 'boolean';
        } else if (type === Function) {
          expectedType = 'function';
          valid = typeof value === 'function';
        } else if (type === Object) {
          expectedType = 'object';
          valid = isPlainObject(value);
        } else if (type === Array) {
          expectedType = 'array';
          valid = isArray(value);
        } else {
          valid = value instanceof type;
        }
      }
      if (!valid) {
        process.env.NODE_ENV !== 'production' && warn('Invalid prop: type check failed for ' + prop.path + '="' + prop.raw + '".' + ' Expected ' + formatType(expectedType) + ', got ' + formatValue(value) + '.');
        return false;
      }
      var validator = options.validator;
      if (validator) {
        if (!validator.call(null, value)) {
          process.env.NODE_ENV !== 'production' && warn('Invalid prop: custom validator check failed for ' + prop.path + '="' + prop.raw + '"');
          return false;
        }
      }
      return true;
    }
    function coerceProp(prop, value) {
      var coerce = prop.options.coerce;
      if (!coerce) {
        return value;
      }
      return coerce(value);
    }
    function formatType(val) {
      return val ? val.charAt(0).toUpperCase() + val.slice(1) : 'custom type';
    }
    function formatValue(val) {
      return Object.prototype.toString.call(val).slice(8, -1);
    }
    var strats = config.optionMergeStrategies = Object.create(null);
    function mergeData(to, from) {
      var key,
          toVal,
          fromVal;
      for (key in from) {
        toVal = to[key];
        fromVal = from[key];
        if (!hasOwn(to, key)) {
          set(to, key, fromVal);
        } else if (isObject(toVal) && isObject(fromVal)) {
          mergeData(toVal, fromVal);
        }
      }
      return to;
    }
    strats.data = function(parentVal, childVal, vm) {
      if (!vm) {
        if (!childVal) {
          return parentVal;
        }
        if (typeof childVal !== 'function') {
          process.env.NODE_ENV !== 'production' && warn('The "data" option should be a function ' + 'that returns a per-instance value in component ' + 'definitions.');
          return parentVal;
        }
        if (!parentVal) {
          return childVal;
        }
        return function mergedDataFn() {
          return mergeData(childVal.call(this), parentVal.call(this));
        };
      } else if (parentVal || childVal) {
        return function mergedInstanceDataFn() {
          var instanceData = typeof childVal === 'function' ? childVal.call(vm) : childVal;
          var defaultData = typeof parentVal === 'function' ? parentVal.call(vm) : undefined;
          if (instanceData) {
            return mergeData(instanceData, defaultData);
          } else {
            return defaultData;
          }
        };
      }
    };
    strats.el = function(parentVal, childVal, vm) {
      if (!vm && childVal && typeof childVal !== 'function') {
        process.env.NODE_ENV !== 'production' && warn('The "el" option should be a function ' + 'that returns a per-instance value in component ' + 'definitions.');
        return;
      }
      var ret = childVal || parentVal;
      return vm && typeof ret === 'function' ? ret.call(vm) : ret;
    };
    strats.init = strats.created = strats.ready = strats.attached = strats.detached = strats.beforeCompile = strats.compiled = strats.beforeDestroy = strats.destroyed = function(parentVal, childVal) {
      return childVal ? parentVal ? parentVal.concat(childVal) : isArray(childVal) ? childVal : [childVal] : parentVal;
    };
    strats.paramAttributes = function() {
      process.env.NODE_ENV !== 'production' && warn('"paramAttributes" option has been deprecated in 0.12. ' + 'Use "props" instead.');
    };
    function mergeAssets(parentVal, childVal) {
      var res = Object.create(parentVal);
      return childVal ? extend(res, guardArrayAssets(childVal)) : res;
    }
    config._assetTypes.forEach(function(type) {
      strats[type + 's'] = mergeAssets;
    });
    strats.watch = strats.events = function(parentVal, childVal) {
      if (!childVal)
        return parentVal;
      if (!parentVal)
        return childVal;
      var ret = {};
      extend(ret, parentVal);
      for (var key in childVal) {
        var parent = ret[key];
        var child = childVal[key];
        if (parent && !isArray(parent)) {
          parent = [parent];
        }
        ret[key] = parent ? parent.concat(child) : [child];
      }
      return ret;
    };
    strats.props = strats.methods = strats.computed = function(parentVal, childVal) {
      if (!childVal)
        return parentVal;
      if (!parentVal)
        return childVal;
      var ret = Object.create(null);
      extend(ret, parentVal);
      extend(ret, childVal);
      return ret;
    };
    var defaultStrat = function defaultStrat(parentVal, childVal) {
      return childVal === undefined ? parentVal : childVal;
    };
    function guardComponents(options) {
      if (options.components) {
        var components = options.components = guardArrayAssets(options.components);
        var def;
        var ids = Object.keys(components);
        for (var i = 0,
            l = ids.length; i < l; i++) {
          var key = ids[i];
          if (commonTagRE.test(key) || reservedTagRE.test(key)) {
            process.env.NODE_ENV !== 'production' && warn('Do not use built-in or reserved HTML elements as component ' + 'id: ' + key);
            continue;
          }
          def = components[key];
          if (isPlainObject(def)) {
            components[key] = Vue.extend(def);
          }
        }
      }
    }
    function guardProps(options) {
      var props = options.props;
      var i,
          val;
      if (isArray(props)) {
        options.props = {};
        i = props.length;
        while (i--) {
          val = props[i];
          if (typeof val === 'string') {
            options.props[val] = null;
          } else if (val.name) {
            options.props[val.name] = val;
          }
        }
      } else if (isPlainObject(props)) {
        var keys = Object.keys(props);
        i = keys.length;
        while (i--) {
          val = props[keys[i]];
          if (typeof val === 'function') {
            props[keys[i]] = {type: val};
          }
        }
      }
    }
    function guardArrayAssets(assets) {
      if (isArray(assets)) {
        var res = {};
        var i = assets.length;
        var asset;
        while (i--) {
          asset = assets[i];
          var id = typeof asset === 'function' ? asset.options && asset.options.name || asset.id : asset.name || asset.id;
          if (!id) {
            process.env.NODE_ENV !== 'production' && warn('Array-syntax assets must provide a "name" or "id" field.');
          } else {
            res[id] = asset;
          }
        }
        return res;
      }
      return assets;
    }
    function mergeOptions(parent, child, vm) {
      guardComponents(child);
      guardProps(child);
      var options = {};
      var key;
      if (child.mixins) {
        for (var i = 0,
            l = child.mixins.length; i < l; i++) {
          parent = mergeOptions(parent, child.mixins[i], vm);
        }
      }
      for (key in parent) {
        mergeField(key);
      }
      for (key in child) {
        if (!hasOwn(parent, key)) {
          mergeField(key);
        }
      }
      function mergeField(key) {
        var strat = strats[key] || defaultStrat;
        options[key] = strat(parent[key], child[key], vm, key);
      }
      return options;
    }
    function resolveAsset(options, type, id) {
      var assets = options[type];
      var camelizedId;
      return assets[id] || assets[camelizedId = camelize(id)] || assets[camelizedId.charAt(0).toUpperCase() + camelizedId.slice(1)];
    }
    function assertAsset(val, type, id) {
      if (!val) {
        process.env.NODE_ENV !== 'production' && warn('Failed to resolve ' + type + ': ' + id);
      }
    }
    var arrayProto = Array.prototype;
    var arrayMethods = Object.create(arrayProto);
    ;
    ['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse'].forEach(function(method) {
      var original = arrayProto[method];
      def(arrayMethods, method, function mutator() {
        var i = arguments.length;
        var args = new Array(i);
        while (i--) {
          args[i] = arguments[i];
        }
        var result = original.apply(this, args);
        var ob = this.__ob__;
        var inserted;
        switch (method) {
          case 'push':
            inserted = args;
            break;
          case 'unshift':
            inserted = args;
            break;
          case 'splice':
            inserted = args.slice(2);
            break;
        }
        if (inserted)
          ob.observeArray(inserted);
        ob.dep.notify();
        return result;
      });
    });
    def(arrayProto, '$set', function $set(index, val) {
      if (index >= this.length) {
        this.length = Number(index) + 1;
      }
      return this.splice(index, 1, val)[0];
    });
    def(arrayProto, '$remove', function $remove(item) {
      if (!this.length)
        return;
      var index = indexOf(this, item);
      if (index > -1) {
        return this.splice(index, 1);
      }
    });
    var uid$3 = 0;
    function Dep() {
      this.id = uid$3++;
      this.subs = [];
    }
    Dep.target = null;
    Dep.prototype.addSub = function(sub) {
      this.subs.push(sub);
    };
    Dep.prototype.removeSub = function(sub) {
      this.subs.$remove(sub);
    };
    Dep.prototype.depend = function() {
      Dep.target.addDep(this);
    };
    Dep.prototype.notify = function() {
      var subs = toArray(this.subs);
      for (var i = 0,
          l = subs.length; i < l; i++) {
        subs[i].update();
      }
    };
    var arrayKeys = Object.getOwnPropertyNames(arrayMethods);
    function Observer(value) {
      this.value = value;
      this.dep = new Dep();
      def(value, '__ob__', this);
      if (isArray(value)) {
        var augment = hasProto ? protoAugment : copyAugment;
        augment(value, arrayMethods, arrayKeys);
        this.observeArray(value);
      } else {
        this.walk(value);
      }
    }
    Observer.prototype.walk = function(obj) {
      var keys = Object.keys(obj);
      for (var i = 0,
          l = keys.length; i < l; i++) {
        this.convert(keys[i], obj[keys[i]]);
      }
    };
    Observer.prototype.observeArray = function(items) {
      for (var i = 0,
          l = items.length; i < l; i++) {
        observe(items[i]);
      }
    };
    Observer.prototype.convert = function(key, val) {
      defineReactive(this.value, key, val);
    };
    Observer.prototype.addVm = function(vm) {
      (this.vms || (this.vms = [])).push(vm);
    };
    Observer.prototype.removeVm = function(vm) {
      this.vms.$remove(vm);
    };
    function protoAugment(target, src) {
      target.__proto__ = src;
    }
    function copyAugment(target, src, keys) {
      for (var i = 0,
          l = keys.length; i < l; i++) {
        var key = keys[i];
        def(target, key, src[key]);
      }
    }
    function observe(value, vm) {
      if (!value || typeof value !== 'object') {
        return;
      }
      var ob;
      if (hasOwn(value, '__ob__') && value.__ob__ instanceof Observer) {
        ob = value.__ob__;
      } else if ((isArray(value) || isPlainObject(value)) && Object.isExtensible(value) && !value._isVue) {
        ob = new Observer(value);
      }
      if (ob && vm) {
        ob.addVm(vm);
      }
      return ob;
    }
    function defineReactive(obj, key, val) {
      var dep = new Dep();
      var getter,
          setter;
      if (config.convertAllProperties) {
        var property = Object.getOwnPropertyDescriptor(obj, key);
        if (property && property.configurable === false) {
          return;
        }
        getter = property && property.get;
        setter = property && property.set;
      }
      var childOb = observe(val);
      Object.defineProperty(obj, key, {
        enumerable: true,
        configurable: true,
        get: function reactiveGetter() {
          var value = getter ? getter.call(obj) : val;
          if (Dep.target) {
            dep.depend();
            if (childOb) {
              childOb.dep.depend();
            }
            if (isArray(value)) {
              for (var e,
                  i = 0,
                  l = value.length; i < l; i++) {
                e = value[i];
                e && e.__ob__ && e.__ob__.dep.depend();
              }
            }
          }
          return value;
        },
        set: function reactiveSetter(newVal) {
          var value = getter ? getter.call(obj) : val;
          if (newVal === value) {
            return;
          }
          if (setter) {
            setter.call(obj, newVal);
          } else {
            val = newVal;
          }
          childOb = observe(newVal);
          dep.notify();
        }
      });
    }
    var util = Object.freeze({
      defineReactive: defineReactive,
      set: set,
      del: del,
      hasOwn: hasOwn,
      isLiteral: isLiteral,
      isReserved: isReserved,
      _toString: _toString,
      toNumber: toNumber,
      toBoolean: toBoolean,
      stripQuotes: stripQuotes,
      camelize: camelize,
      hyphenate: hyphenate,
      classify: classify,
      bind: bind$1,
      toArray: toArray,
      extend: extend,
      isObject: isObject,
      isPlainObject: isPlainObject,
      def: def,
      debounce: _debounce,
      indexOf: indexOf,
      cancellable: cancellable,
      looseEqual: looseEqual,
      isArray: isArray,
      hasProto: hasProto,
      inBrowser: inBrowser,
      isIE9: isIE9,
      isAndroid: isAndroid,
      get transitionProp() {
        return transitionProp;
      },
      get transitionEndEvent() {
        return transitionEndEvent;
      },
      get animationProp() {
        return animationProp;
      },
      get animationEndEvent() {
        return animationEndEvent;
      },
      nextTick: nextTick,
      query: query,
      inDoc: inDoc,
      getAttr: getAttr,
      getBindAttr: getBindAttr,
      hasBindAttr: hasBindAttr,
      before: before,
      after: after,
      remove: remove,
      prepend: prepend,
      replace: replace,
      on: on$1,
      off: off,
      setClass: setClass,
      addClass: addClass,
      removeClass: removeClass,
      extractContent: extractContent,
      trimNode: trimNode,
      isTemplate: isTemplate,
      createAnchor: createAnchor,
      findRef: findRef,
      mapNodeRange: mapNodeRange,
      removeNodeRange: removeNodeRange,
      mergeOptions: mergeOptions,
      resolveAsset: resolveAsset,
      assertAsset: assertAsset,
      checkComponentAttr: checkComponentAttr,
      initProp: initProp,
      assertProp: assertProp,
      coerceProp: coerceProp,
      commonTagRE: commonTagRE,
      reservedTagRE: reservedTagRE,
      get warn() {
        return warn;
      }
    });
    var uid = 0;
    function initMixin(Vue) {
      Vue.prototype._init = function(options) {
        options = options || {};
        this.$el = null;
        this.$parent = options.parent;
        this.$root = this.$parent ? this.$parent.$root : this;
        this.$children = [];
        this.$refs = {};
        this.$els = {};
        this._watchers = [];
        this._directives = [];
        this._uid = uid++;
        this._isVue = true;
        this._events = {};
        this._eventsCount = {};
        this._isFragment = false;
        this._fragment = this._fragmentStart = this._fragmentEnd = null;
        this._isCompiled = this._isDestroyed = this._isReady = this._isAttached = this._isBeingDestroyed = false;
        this._unlinkFn = null;
        this._context = options._context || this.$parent;
        this._scope = options._scope;
        this._frag = options._frag;
        if (this._frag) {
          this._frag.children.push(this);
        }
        if (this.$parent) {
          this.$parent.$children.push(this);
        }
        options = this.$options = mergeOptions(this.constructor.options, options, this);
        this._updateRef();
        this._data = {};
        this._callHook('init');
        this._initState();
        this._initEvents();
        this._callHook('created');
        if (options.el) {
          this.$mount(options.el);
        }
      };
    }
    var pathCache = new Cache(1000);
    var APPEND = 0;
    var PUSH = 1;
    var INC_SUB_PATH_DEPTH = 2;
    var PUSH_SUB_PATH = 3;
    var BEFORE_PATH = 0;
    var IN_PATH = 1;
    var BEFORE_IDENT = 2;
    var IN_IDENT = 3;
    var IN_SUB_PATH = 4;
    var IN_SINGLE_QUOTE = 5;
    var IN_DOUBLE_QUOTE = 6;
    var AFTER_PATH = 7;
    var ERROR = 8;
    var pathStateMachine = [];
    pathStateMachine[BEFORE_PATH] = {
      'ws': [BEFORE_PATH],
      'ident': [IN_IDENT, APPEND],
      '[': [IN_SUB_PATH],
      'eof': [AFTER_PATH]
    };
    pathStateMachine[IN_PATH] = {
      'ws': [IN_PATH],
      '.': [BEFORE_IDENT],
      '[': [IN_SUB_PATH],
      'eof': [AFTER_PATH]
    };
    pathStateMachine[BEFORE_IDENT] = {
      'ws': [BEFORE_IDENT],
      'ident': [IN_IDENT, APPEND]
    };
    pathStateMachine[IN_IDENT] = {
      'ident': [IN_IDENT, APPEND],
      '0': [IN_IDENT, APPEND],
      'number': [IN_IDENT, APPEND],
      'ws': [IN_PATH, PUSH],
      '.': [BEFORE_IDENT, PUSH],
      '[': [IN_SUB_PATH, PUSH],
      'eof': [AFTER_PATH, PUSH]
    };
    pathStateMachine[IN_SUB_PATH] = {
      "'": [IN_SINGLE_QUOTE, APPEND],
      '"': [IN_DOUBLE_QUOTE, APPEND],
      '[': [IN_SUB_PATH, INC_SUB_PATH_DEPTH],
      ']': [IN_PATH, PUSH_SUB_PATH],
      'eof': ERROR,
      'else': [IN_SUB_PATH, APPEND]
    };
    pathStateMachine[IN_SINGLE_QUOTE] = {
      "'": [IN_SUB_PATH, APPEND],
      'eof': ERROR,
      'else': [IN_SINGLE_QUOTE, APPEND]
    };
    pathStateMachine[IN_DOUBLE_QUOTE] = {
      '"': [IN_SUB_PATH, APPEND],
      'eof': ERROR,
      'else': [IN_DOUBLE_QUOTE, APPEND]
    };
    function getPathCharType(ch) {
      if (ch === undefined) {
        return 'eof';
      }
      var code = ch.charCodeAt(0);
      switch (code) {
        case 0x5B:
        case 0x5D:
        case 0x2E:
        case 0x22:
        case 0x27:
        case 0x30:
          return ch;
        case 0x5F:
        case 0x24:
          return 'ident';
        case 0x20:
        case 0x09:
        case 0x0A:
        case 0x0D:
        case 0xA0:
        case 0xFEFF:
        case 0x2028:
        case 0x2029:
          return 'ws';
      }
      if (code >= 0x61 && code <= 0x7A || code >= 0x41 && code <= 0x5A) {
        return 'ident';
      }
      if (code >= 0x31 && code <= 0x39) {
        return 'number';
      }
      return 'else';
    }
    function formatSubPath(path) {
      var trimmed = path.trim();
      if (path.charAt(0) === '0' && isNaN(path)) {
        return false;
      }
      return isLiteral(trimmed) ? stripQuotes(trimmed) : '*' + trimmed;
    }
    function parse(path) {
      var keys = [];
      var index = -1;
      var mode = BEFORE_PATH;
      var subPathDepth = 0;
      var c,
          newChar,
          key,
          type,
          transition,
          action,
          typeMap;
      var actions = [];
      actions[PUSH] = function() {
        if (key !== undefined) {
          keys.push(key);
          key = undefined;
        }
      };
      actions[APPEND] = function() {
        if (key === undefined) {
          key = newChar;
        } else {
          key += newChar;
        }
      };
      actions[INC_SUB_PATH_DEPTH] = function() {
        actions[APPEND]();
        subPathDepth++;
      };
      actions[PUSH_SUB_PATH] = function() {
        if (subPathDepth > 0) {
          subPathDepth--;
          mode = IN_SUB_PATH;
          actions[APPEND]();
        } else {
          subPathDepth = 0;
          key = formatSubPath(key);
          if (key === false) {
            return false;
          } else {
            actions[PUSH]();
          }
        }
      };
      function maybeUnescapeQuote() {
        var nextChar = path[index + 1];
        if (mode === IN_SINGLE_QUOTE && nextChar === "'" || mode === IN_DOUBLE_QUOTE && nextChar === '"') {
          index++;
          newChar = '\\' + nextChar;
          actions[APPEND]();
          return true;
        }
      }
      while (mode != null) {
        index++;
        c = path[index];
        if (c === '\\' && maybeUnescapeQuote()) {
          continue;
        }
        type = getPathCharType(c);
        typeMap = pathStateMachine[mode];
        transition = typeMap[type] || typeMap['else'] || ERROR;
        if (transition === ERROR) {
          return;
        }
        mode = transition[0];
        action = actions[transition[1]];
        if (action) {
          newChar = transition[2];
          newChar = newChar === undefined ? c : newChar;
          if (action() === false) {
            return;
          }
        }
        if (mode === AFTER_PATH) {
          keys.raw = path;
          return keys;
        }
      }
    }
    function parsePath(path) {
      var hit = pathCache.get(path);
      if (!hit) {
        hit = parse(path);
        if (hit) {
          pathCache.put(path, hit);
        }
      }
      return hit;
    }
    function getPath(obj, path) {
      return parseExpression(path).get(obj);
    }
    var warnNonExistent;
    if (process.env.NODE_ENV !== 'production') {
      warnNonExistent = function(path) {
        warn('You are setting a non-existent path "' + path.raw + '" ' + 'on a vm instance. Consider pre-initializing the property ' + 'with the "data" option for more reliable reactivity ' + 'and better performance.');
      };
    }
    function setPath(obj, path, val) {
      var original = obj;
      if (typeof path === 'string') {
        path = parse(path);
      }
      if (!path || !isObject(obj)) {
        return false;
      }
      var last,
          key;
      for (var i = 0,
          l = path.length; i < l; i++) {
        last = obj;
        key = path[i];
        if (key.charAt(0) === '*') {
          key = parseExpression(key.slice(1)).get.call(original, original);
        }
        if (i < l - 1) {
          obj = obj[key];
          if (!isObject(obj)) {
            obj = {};
            if (process.env.NODE_ENV !== 'production' && last._isVue) {
              warnNonExistent(path);
            }
            set(last, key, obj);
          }
        } else {
          if (isArray(obj)) {
            obj.$set(key, val);
          } else if (key in obj) {
            obj[key] = val;
          } else {
            if (process.env.NODE_ENV !== 'production' && obj._isVue) {
              warnNonExistent(path);
            }
            set(obj, key, val);
          }
        }
      }
      return true;
    }
    var path = Object.freeze({
      parsePath: parsePath,
      getPath: getPath,
      setPath: setPath
    });
    var expressionCache = new Cache(1000);
    var allowedKeywords = 'Math,Date,this,true,false,null,undefined,Infinity,NaN,' + 'isNaN,isFinite,decodeURI,decodeURIComponent,encodeURI,' + 'encodeURIComponent,parseInt,parseFloat';
    var allowedKeywordsRE = new RegExp('^(' + allowedKeywords.replace(/,/g, '\\b|') + '\\b)');
    var improperKeywords = 'break,case,class,catch,const,continue,debugger,default,' + 'delete,do,else,export,extends,finally,for,function,if,' + 'import,in,instanceof,let,return,super,switch,throw,try,' + 'var,while,with,yield,enum,await,implements,package,' + 'proctected,static,interface,private,public';
    var improperKeywordsRE = new RegExp('^(' + improperKeywords.replace(/,/g, '\\b|') + '\\b)');
    var wsRE = /\s/g;
    var newlineRE = /\n/g;
    var saveRE = /[\{,]\s*[\w\$_]+\s*:|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|new |typeof |void /g;
    var restoreRE = /"(\d+)"/g;
    var pathTestRE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\['.*?'\]|\[".*?"\]|\[\d+\]|\[[A-Za-z_$][\w$]*\])*$/;
    var identRE = /[^\w$\.](?:[A-Za-z_$][\w$]*)/g;
    var booleanLiteralRE = /^(?:true|false)$/;
    var saved = [];
    function save(str, isString) {
      var i = saved.length;
      saved[i] = isString ? str.replace(newlineRE, '\\n') : str;
      return '"' + i + '"';
    }
    function rewrite(raw) {
      var c = raw.charAt(0);
      var path = raw.slice(1);
      if (allowedKeywordsRE.test(path)) {
        return raw;
      } else {
        path = path.indexOf('"') > -1 ? path.replace(restoreRE, restore) : path;
        return c + 'scope.' + path;
      }
    }
    function restore(str, i) {
      return saved[i];
    }
    function compileGetter(exp) {
      if (improperKeywordsRE.test(exp)) {
        process.env.NODE_ENV !== 'production' && warn('Avoid using reserved keywords in expression: ' + exp);
      }
      saved.length = 0;
      var body = exp.replace(saveRE, save).replace(wsRE, '');
      body = (' ' + body).replace(identRE, rewrite).replace(restoreRE, restore);
      return makeGetterFn(body);
    }
    function makeGetterFn(body) {
      try {
        return new Function('scope', 'return ' + body + ';');
      } catch (e) {
        process.env.NODE_ENV !== 'production' && warn('Invalid expression. ' + 'Generated function body: ' + body);
      }
    }
    function compileSetter(exp) {
      var path = parsePath(exp);
      if (path) {
        return function(scope, val) {
          setPath(scope, path, val);
        };
      } else {
        process.env.NODE_ENV !== 'production' && warn('Invalid setter expression: ' + exp);
      }
    }
    function parseExpression(exp, needSet) {
      exp = exp.trim();
      var hit = expressionCache.get(exp);
      if (hit) {
        if (needSet && !hit.set) {
          hit.set = compileSetter(hit.exp);
        }
        return hit;
      }
      var res = {exp: exp};
      res.get = isSimplePath(exp) && exp.indexOf('[') < 0 ? makeGetterFn('scope.' + exp) : compileGetter(exp);
      if (needSet) {
        res.set = compileSetter(exp);
      }
      expressionCache.put(exp, res);
      return res;
    }
    function isSimplePath(exp) {
      return pathTestRE.test(exp) && !booleanLiteralRE.test(exp) && exp.slice(0, 5) !== 'Math.';
    }
    var expression = Object.freeze({
      parseExpression: parseExpression,
      isSimplePath: isSimplePath
    });
    var queue = [];
    var userQueue = [];
    var has = {};
    var circular = {};
    var waiting = false;
    var internalQueueDepleted = false;
    function resetBatcherState() {
      queue = [];
      userQueue = [];
      has = {};
      circular = {};
      waiting = internalQueueDepleted = false;
    }
    function flushBatcherQueue() {
      runBatcherQueue(queue);
      internalQueueDepleted = true;
      runBatcherQueue(userQueue);
      if (process.env.NODE_ENV !== 'production') {
        if (inBrowser && window.__VUE_DEVTOOLS_GLOBAL_HOOK__) {
          window.__VUE_DEVTOOLS_GLOBAL_HOOK__.emit('flush');
        }
      }
      resetBatcherState();
    }
    function runBatcherQueue(queue) {
      for (var i = 0; i < queue.length; i++) {
        var watcher = queue[i];
        var id = watcher.id;
        has[id] = null;
        watcher.run();
        if (process.env.NODE_ENV !== 'production' && has[id] != null) {
          circular[id] = (circular[id] || 0) + 1;
          if (circular[id] > config._maxUpdateCount) {
            queue.splice(has[id], 1);
            warn('You may have an infinite update loop for watcher ' + 'with expression: ' + watcher.expression);
          }
        }
      }
    }
    function pushWatcher(watcher) {
      var id = watcher.id;
      if (has[id] == null) {
        if (internalQueueDepleted && !watcher.user) {
          watcher.run();
          return;
        }
        var q = watcher.user ? userQueue : queue;
        has[id] = q.length;
        q.push(watcher);
        if (!waiting) {
          waiting = true;
          nextTick(flushBatcherQueue);
        }
      }
    }
    var uid$2 = 0;
    function Watcher(vm, expOrFn, cb, options) {
      if (options) {
        extend(this, options);
      }
      var isFn = typeof expOrFn === 'function';
      this.vm = vm;
      vm._watchers.push(this);
      this.expression = isFn ? expOrFn.toString() : expOrFn;
      this.cb = cb;
      this.id = ++uid$2;
      this.active = true;
      this.dirty = this.lazy;
      this.deps = Object.create(null);
      this.newDeps = null;
      this.prevError = null;
      if (isFn) {
        this.getter = expOrFn;
        this.setter = undefined;
      } else {
        var res = parseExpression(expOrFn, this.twoWay);
        this.getter = res.get;
        this.setter = res.set;
      }
      this.value = this.lazy ? undefined : this.get();
      this.queued = this.shallow = false;
    }
    Watcher.prototype.addDep = function(dep) {
      var id = dep.id;
      if (!this.newDeps[id]) {
        this.newDeps[id] = dep;
        if (!this.deps[id]) {
          this.deps[id] = dep;
          dep.addSub(this);
        }
      }
    };
    Watcher.prototype.get = function() {
      this.beforeGet();
      var scope = this.scope || this.vm;
      var value;
      try {
        value = this.getter.call(scope, scope);
      } catch (e) {
        if (process.env.NODE_ENV !== 'production' && config.warnExpressionErrors) {
          warn('Error when evaluating expression "' + this.expression + '". ' + (config.debug ? '' : 'Turn on debug mode to see stack trace.'), e);
        }
      }
      if (this.deep) {
        traverse(value);
      }
      if (this.preProcess) {
        value = this.preProcess(value);
      }
      if (this.filters) {
        value = scope._applyFilters(value, null, this.filters, false);
      }
      if (this.postProcess) {
        value = this.postProcess(value);
      }
      this.afterGet();
      return value;
    };
    Watcher.prototype.set = function(value) {
      var scope = this.scope || this.vm;
      if (this.filters) {
        value = scope._applyFilters(value, this.value, this.filters, true);
      }
      try {
        this.setter.call(scope, scope, value);
      } catch (e) {
        if (process.env.NODE_ENV !== 'production' && config.warnExpressionErrors) {
          warn('Error when evaluating setter "' + this.expression + '"', e);
        }
      }
      var forContext = scope.$forContext;
      if (forContext && forContext.alias === this.expression) {
        if (forContext.filters) {
          process.env.NODE_ENV !== 'production' && warn('It seems you are using two-way binding on ' + 'a v-for alias (' + this.expression + '), and the ' + 'v-for has filters. This will not work properly. ' + 'Either remove the filters or use an array of ' + 'objects and bind to object properties instead.');
          return;
        }
        forContext._withLock(function() {
          if (scope.$key) {
            forContext.rawValue[scope.$key] = value;
          } else {
            forContext.rawValue.$set(scope.$index, value);
          }
        });
      }
    };
    Watcher.prototype.beforeGet = function() {
      Dep.target = this;
      this.newDeps = Object.create(null);
    };
    Watcher.prototype.afterGet = function() {
      Dep.target = null;
      var ids = Object.keys(this.deps);
      var i = ids.length;
      while (i--) {
        var id = ids[i];
        if (!this.newDeps[id]) {
          this.deps[id].removeSub(this);
        }
      }
      this.deps = this.newDeps;
    };
    Watcher.prototype.update = function(shallow) {
      if (this.lazy) {
        this.dirty = true;
      } else if (this.sync || !config.async) {
        this.run();
      } else {
        this.shallow = this.queued ? shallow ? this.shallow : false : !!shallow;
        this.queued = true;
        if (process.env.NODE_ENV !== 'production' && config.debug) {
          this.prevError = new Error('[vue] async stack trace');
        }
        pushWatcher(this);
      }
    };
    Watcher.prototype.run = function() {
      if (this.active) {
        var value = this.get();
        if (value !== this.value || (isObject(value) || this.deep) && !this.shallow) {
          var oldValue = this.value;
          this.value = value;
          var prevError = this.prevError;
          if (process.env.NODE_ENV !== 'production' && config.debug && prevError) {
            this.prevError = null;
            try {
              this.cb.call(this.vm, value, oldValue);
            } catch (e) {
              nextTick(function() {
                throw prevError;
              }, 0);
              throw e;
            }
          } else {
            this.cb.call(this.vm, value, oldValue);
          }
        }
        this.queued = this.shallow = false;
      }
    };
    Watcher.prototype.evaluate = function() {
      var current = Dep.target;
      this.value = this.get();
      this.dirty = false;
      Dep.target = current;
    };
    Watcher.prototype.depend = function() {
      var depIds = Object.keys(this.deps);
      var i = depIds.length;
      while (i--) {
        this.deps[depIds[i]].depend();
      }
    };
    Watcher.prototype.teardown = function() {
      if (this.active) {
        if (!this.vm._isBeingDestroyed) {
          this.vm._watchers.$remove(this);
        }
        var depIds = Object.keys(this.deps);
        var i = depIds.length;
        while (i--) {
          this.deps[depIds[i]].removeSub(this);
        }
        this.active = false;
        this.vm = this.cb = this.value = null;
      }
    };
    function traverse(val) {
      var i,
          keys;
      if (isArray(val)) {
        i = val.length;
        while (i--)
          traverse(val[i]);
      } else if (isObject(val)) {
        keys = Object.keys(val);
        i = keys.length;
        while (i--)
          traverse(val[keys[i]]);
      }
    }
    var cloak = {bind: function bind() {
        var el = this.el;
        this.vm.$once('pre-hook:compiled', function() {
          el.removeAttribute('v-cloak');
        });
      }};
    var ref = {bind: function bind() {
        process.env.NODE_ENV !== 'production' && warn('v-ref:' + this.arg + ' must be used on a child ' + 'component. Found on <' + this.el.tagName.toLowerCase() + '>.');
      }};
    var ON = 700;
    var MODEL = 800;
    var BIND = 850;
    var TRANSITION = 1100;
    var EL = 1500;
    var COMPONENT = 1500;
    var PARTIAL = 1750;
    var SLOT = 1750;
    var FOR = 2000;
    var IF = 2000;
    var el = {
      priority: EL,
      bind: function bind() {
        if (!this.arg) {
          return;
        }
        var id = this.id = camelize(this.arg);
        var refs = (this._scope || this.vm).$els;
        if (hasOwn(refs, id)) {
          refs[id] = this.el;
        } else {
          defineReactive(refs, id, this.el);
        }
      },
      unbind: function unbind() {
        var refs = (this._scope || this.vm).$els;
        if (refs[this.id] === this.el) {
          refs[this.id] = null;
        }
      }
    };
    var prefixes = ['-webkit-', '-moz-', '-ms-'];
    var camelPrefixes = ['Webkit', 'Moz', 'ms'];
    var importantRE = /!important;?$/;
    var propCache = Object.create(null);
    var testEl = null;
    var style = {
      deep: true,
      update: function update(value) {
        if (typeof value === 'string') {
          this.el.style.cssText = value;
        } else if (isArray(value)) {
          this.handleObject(value.reduce(extend, {}));
        } else {
          this.handleObject(value || {});
        }
      },
      handleObject: function handleObject(value) {
        var cache = this.cache || (this.cache = {});
        var name,
            val;
        for (name in cache) {
          if (!(name in value)) {
            this.handleSingle(name, null);
            delete cache[name];
          }
        }
        for (name in value) {
          val = value[name];
          if (val !== cache[name]) {
            cache[name] = val;
            this.handleSingle(name, val);
          }
        }
      },
      handleSingle: function handleSingle(prop, value) {
        prop = normalize(prop);
        if (!prop)
          return;
        if (value != null)
          value += '';
        if (value) {
          var isImportant = importantRE.test(value) ? 'important' : '';
          if (isImportant) {
            value = value.replace(importantRE, '').trim();
          }
          this.el.style.setProperty(prop, value, isImportant);
        } else {
          this.el.style.removeProperty(prop);
        }
      }
    };
    function normalize(prop) {
      if (propCache[prop]) {
        return propCache[prop];
      }
      var res = prefix(prop);
      propCache[prop] = propCache[res] = res;
      return res;
    }
    function prefix(prop) {
      prop = hyphenate(prop);
      var camel = camelize(prop);
      var upper = camel.charAt(0).toUpperCase() + camel.slice(1);
      if (!testEl) {
        testEl = document.createElement('div');
      }
      if (camel in testEl.style) {
        return prop;
      }
      var i = prefixes.length;
      var prefixed;
      while (i--) {
        prefixed = camelPrefixes[i] + upper;
        if (prefixed in testEl.style) {
          return prefixes[i] + prop;
        }
      }
    }
    var xlinkNS = 'http://www.w3.org/1999/xlink';
    var xlinkRE = /^xlink:/;
    var disallowedInterpAttrRE = /^v-|^:|^@|^(is|transition|transition-mode|debounce|track-by|stagger|enter-stagger|leave-stagger)$/;
    var attrWithPropsRE = /^(value|checked|selected|muted)$/;
    var modelProps = {
      value: '_value',
      'true-value': '_trueValue',
      'false-value': '_falseValue'
    };
    var bind = {
      priority: BIND,
      bind: function bind() {
        var attr = this.arg;
        var tag = this.el.tagName;
        if (!attr) {
          this.deep = true;
        }
        if (this.descriptor.interp) {
          if (disallowedInterpAttrRE.test(attr) || attr === 'name' && (tag === 'PARTIAL' || tag === 'SLOT')) {
            process.env.NODE_ENV !== 'production' && warn(attr + '="' + this.descriptor.raw + '": ' + 'attribute interpolation is not allowed in Vue.js ' + 'directives and special attributes.');
            this.el.removeAttribute(attr);
            this.invalid = true;
          }
          if (process.env.NODE_ENV !== 'production') {
            var raw = attr + '="' + this.descriptor.raw + '": ';
            if (attr === 'src') {
              warn(raw + 'interpolation in "src" attribute will cause ' + 'a 404 request. Use v-bind:src instead.');
            }
            if (attr === 'style') {
              warn(raw + 'interpolation in "style" attribute will cause ' + 'the attribute to be discarded in Internet Explorer. ' + 'Use v-bind:style instead.');
            }
          }
        }
      },
      update: function update(value) {
        if (this.invalid) {
          return;
        }
        var attr = this.arg;
        if (this.arg) {
          this.handleSingle(attr, value);
        } else {
          this.handleObject(value || {});
        }
      },
      handleObject: style.handleObject,
      handleSingle: function handleSingle(attr, value) {
        var el = this.el;
        var interp = this.descriptor.interp;
        if (!interp && attrWithPropsRE.test(attr) && attr in el) {
          el[attr] = attr === 'value' ? value == null ? '' : value : value;
        }
        var modelProp = modelProps[attr];
        if (!interp && modelProp) {
          el[modelProp] = value;
          var model = el.__v_model;
          if (model) {
            model.listener();
          }
        }
        if (attr === 'value' && el.tagName === 'TEXTAREA') {
          el.removeAttribute(attr);
          return;
        }
        if (value != null && value !== false) {
          if (attr === 'class') {
            if (el.__v_trans) {
              value += ' ' + el.__v_trans.id + '-transition';
            }
            setClass(el, value);
          } else if (xlinkRE.test(attr)) {
            el.setAttributeNS(xlinkNS, attr, value);
          } else {
            el.setAttribute(attr, value);
          }
        } else {
          el.removeAttribute(attr);
        }
      }
    };
    var keyCodes = {
      esc: 27,
      tab: 9,
      enter: 13,
      space: 32,
      'delete': 46,
      up: 38,
      left: 37,
      right: 39,
      down: 40
    };
    function keyFilter(handler, keys) {
      var codes = keys.map(function(key) {
        var charCode = key.charCodeAt(0);
        if (charCode > 47 && charCode < 58) {
          return parseInt(key, 10);
        }
        if (key.length === 1) {
          charCode = key.toUpperCase().charCodeAt(0);
          if (charCode > 64 && charCode < 91) {
            return charCode;
          }
        }
        return keyCodes[key];
      });
      return function keyHandler(e) {
        if (codes.indexOf(e.keyCode) > -1) {
          return handler.call(this, e);
        }
      };
    }
    function stopFilter(handler) {
      return function stopHandler(e) {
        e.stopPropagation();
        return handler.call(this, e);
      };
    }
    function preventFilter(handler) {
      return function preventHandler(e) {
        e.preventDefault();
        return handler.call(this, e);
      };
    }
    var on = {
      acceptStatement: true,
      priority: ON,
      bind: function bind() {
        if (this.el.tagName === 'IFRAME' && this.arg !== 'load') {
          var self = this;
          this.iframeBind = function() {
            on$1(self.el.contentWindow, self.arg, self.handler);
          };
          this.on('load', this.iframeBind);
        }
      },
      update: function update(handler) {
        if (!this.descriptor.raw) {
          handler = function() {};
        }
        if (typeof handler !== 'function') {
          process.env.NODE_ENV !== 'production' && warn('v-on:' + this.arg + '="' + this.expression + '" expects a function value, ' + 'got ' + handler);
          return;
        }
        if (this.modifiers.stop) {
          handler = stopFilter(handler);
        }
        if (this.modifiers.prevent) {
          handler = preventFilter(handler);
        }
        var keys = Object.keys(this.modifiers).filter(function(key) {
          return key !== 'stop' && key !== 'prevent';
        });
        if (keys.length) {
          handler = keyFilter(handler, keys);
        }
        this.reset();
        this.handler = handler;
        if (this.iframeBind) {
          this.iframeBind();
        } else {
          on$1(this.el, this.arg, this.handler);
        }
      },
      reset: function reset() {
        var el = this.iframeBind ? this.el.contentWindow : this.el;
        if (this.handler) {
          off(el, this.arg, this.handler);
        }
      },
      unbind: function unbind() {
        this.reset();
      }
    };
    var checkbox = {
      bind: function bind() {
        var self = this;
        var el = this.el;
        this.getValue = function() {
          return el.hasOwnProperty('_value') ? el._value : self.params.number ? toNumber(el.value) : el.value;
        };
        function getBooleanValue() {
          var val = el.checked;
          if (val && el.hasOwnProperty('_trueValue')) {
            return el._trueValue;
          }
          if (!val && el.hasOwnProperty('_falseValue')) {
            return el._falseValue;
          }
          return val;
        }
        this.listener = function() {
          var model = self._watcher.value;
          if (isArray(model)) {
            var val = self.getValue();
            if (el.checked) {
              if (indexOf(model, val) < 0) {
                model.push(val);
              }
            } else {
              model.$remove(val);
            }
          } else {
            self.set(getBooleanValue());
          }
        };
        this.on('change', this.listener);
        if (el.hasAttribute('checked')) {
          this.afterBind = this.listener;
        }
      },
      update: function update(value) {
        var el = this.el;
        if (isArray(value)) {
          el.checked = indexOf(value, this.getValue()) > -1;
        } else {
          if (el.hasOwnProperty('_trueValue')) {
            el.checked = looseEqual(value, el._trueValue);
          } else {
            el.checked = !!value;
          }
        }
      }
    };
    var select = {
      bind: function bind() {
        var self = this;
        var el = this.el;
        this.forceUpdate = function() {
          if (self._watcher) {
            self.update(self._watcher.get());
          }
        };
        var multiple = this.multiple = el.hasAttribute('multiple');
        this.listener = function() {
          var value = getValue(el, multiple);
          value = self.params.number ? isArray(value) ? value.map(toNumber) : toNumber(value) : value;
          self.set(value);
        };
        this.on('change', this.listener);
        var initValue = getValue(el, multiple, true);
        if (multiple && initValue.length || !multiple && initValue !== null) {
          this.afterBind = this.listener;
        }
        this.vm.$on('hook:attached', this.forceUpdate);
      },
      update: function update(value) {
        var el = this.el;
        el.selectedIndex = -1;
        var multi = this.multiple && isArray(value);
        var options = el.options;
        var i = options.length;
        var op,
            val;
        while (i--) {
          op = options[i];
          val = op.hasOwnProperty('_value') ? op._value : op.value;
          op.selected = multi ? indexOf$1(value, val) > -1 : looseEqual(value, val);
        }
      },
      unbind: function unbind() {
        this.vm.$off('hook:attached', this.forceUpdate);
      }
    };
    function getValue(el, multi, init) {
      var res = multi ? [] : null;
      var op,
          val,
          selected;
      for (var i = 0,
          l = el.options.length; i < l; i++) {
        op = el.options[i];
        selected = init ? op.hasAttribute('selected') : op.selected;
        if (selected) {
          val = op.hasOwnProperty('_value') ? op._value : op.value;
          if (multi) {
            res.push(val);
          } else {
            return val;
          }
        }
      }
      return res;
    }
    function indexOf$1(arr, val) {
      var i = arr.length;
      while (i--) {
        if (looseEqual(arr[i], val)) {
          return i;
        }
      }
      return -1;
    }
    var radio = {
      bind: function bind() {
        var self = this;
        var el = this.el;
        this.getValue = function() {
          if (el.hasOwnProperty('_value')) {
            return el._value;
          }
          var val = el.value;
          if (self.params.number) {
            val = toNumber(val);
          }
          return val;
        };
        this.listener = function() {
          self.set(self.getValue());
        };
        this.on('change', this.listener);
        if (el.hasAttribute('checked')) {
          this.afterBind = this.listener;
        }
      },
      update: function update(value) {
        this.el.checked = looseEqual(value, this.getValue());
      }
    };
    var text$2 = {
      bind: function bind() {
        var self = this;
        var el = this.el;
        var isRange = el.type === 'range';
        var lazy = this.params.lazy;
        var number = this.params.number;
        var debounce = this.params.debounce;
        var composing = false;
        if (!isAndroid && !isRange) {
          this.on('compositionstart', function() {
            composing = true;
          });
          this.on('compositionend', function() {
            composing = false;
            if (!lazy) {
              self.listener();
            }
          });
        }
        this.focused = false;
        if (!isRange) {
          this.on('focus', function() {
            self.focused = true;
          });
          this.on('blur', function() {
            self.focused = false;
            if (!self._frag || self._frag.inserted) {
              self.rawListener();
            }
          });
        }
        this.listener = this.rawListener = function() {
          if (composing || !self._bound) {
            return;
          }
          var val = number || isRange ? toNumber(el.value) : el.value;
          self.set(val);
          nextTick(function() {
            if (self._bound && !self.focused) {
              self.update(self._watcher.value);
            }
          });
        };
        if (debounce) {
          this.listener = _debounce(this.listener, debounce);
        }
        this.hasjQuery = typeof jQuery === 'function';
        if (this.hasjQuery) {
          jQuery(el).on('change', this.listener);
          if (!lazy) {
            jQuery(el).on('input', this.listener);
          }
        } else {
          this.on('change', this.listener);
          if (!lazy) {
            this.on('input', this.listener);
          }
        }
        if (!lazy && isIE9) {
          this.on('cut', function() {
            nextTick(self.listener);
          });
          this.on('keyup', function(e) {
            if (e.keyCode === 46 || e.keyCode === 8) {
              self.listener();
            }
          });
        }
        if (el.hasAttribute('value') || el.tagName === 'TEXTAREA' && el.value.trim()) {
          this.afterBind = this.listener;
        }
      },
      update: function update(value) {
        this.el.value = _toString(value);
      },
      unbind: function unbind() {
        var el = this.el;
        if (this.hasjQuery) {
          jQuery(el).off('change', this.listener);
          jQuery(el).off('input', this.listener);
        }
      }
    };
    var handlers = {
      text: text$2,
      radio: radio,
      select: select,
      checkbox: checkbox
    };
    var model = {
      priority: MODEL,
      twoWay: true,
      handlers: handlers,
      params: ['lazy', 'number', 'debounce'],
      bind: function bind() {
        this.checkFilters();
        if (this.hasRead && !this.hasWrite) {
          process.env.NODE_ENV !== 'production' && warn('It seems you are using a read-only filter with ' + 'v-model. You might want to use a two-way filter ' + 'to ensure correct behavior.');
        }
        var el = this.el;
        var tag = el.tagName;
        var handler;
        if (tag === 'INPUT') {
          handler = handlers[el.type] || handlers.text;
        } else if (tag === 'SELECT') {
          handler = handlers.select;
        } else if (tag === 'TEXTAREA') {
          handler = handlers.text;
        } else {
          process.env.NODE_ENV !== 'production' && warn('v-model does not support element type: ' + tag);
          return;
        }
        el.__v_model = this;
        handler.bind.call(this);
        this.update = handler.update;
        this._unbind = handler.unbind;
      },
      checkFilters: function checkFilters() {
        var filters = this.filters;
        if (!filters)
          return;
        var i = filters.length;
        while (i--) {
          var filter = resolveAsset(this.vm.$options, 'filters', filters[i].name);
          if (typeof filter === 'function' || filter.read) {
            this.hasRead = true;
          }
          if (filter.write) {
            this.hasWrite = true;
          }
        }
      },
      unbind: function unbind() {
        this.el.__v_model = null;
        this._unbind && this._unbind();
      }
    };
    var show = {
      bind: function bind() {
        var next = this.el.nextElementSibling;
        if (next && getAttr(next, 'v-else') !== null) {
          this.elseEl = next;
        }
      },
      update: function update(value) {
        this.apply(this.el, value);
        if (this.elseEl) {
          this.apply(this.elseEl, !value);
        }
      },
      apply: function apply(el, value) {
        if (inDoc(el)) {
          applyTransition(el, value ? 1 : -1, toggle, this.vm);
        } else {
          toggle();
        }
        function toggle() {
          el.style.display = value ? '' : 'none';
        }
      }
    };
    var templateCache = new Cache(1000);
    var idSelectorCache = new Cache(1000);
    var map = {
      efault: [0, '', ''],
      legend: [1, '<fieldset>', '</fieldset>'],
      tr: [2, '<table><tbody>', '</tbody></table>'],
      col: [2, '<table><tbody></tbody><colgroup>', '</colgroup></table>']
    };
    map.td = map.th = [3, '<table><tbody><tr>', '</tr></tbody></table>'];
    map.option = map.optgroup = [1, '<select multiple="multiple">', '</select>'];
    map.thead = map.tbody = map.colgroup = map.caption = map.tfoot = [1, '<table>', '</table>'];
    map.g = map.defs = map.symbol = map.use = map.image = map.text = map.circle = map.ellipse = map.line = map.path = map.polygon = map.polyline = map.rect = [1, '<svg ' + 'xmlns="http://www.w3.org/2000/svg" ' + 'xmlns:xlink="http://www.w3.org/1999/xlink" ' + 'xmlns:ev="http://www.w3.org/2001/xml-events"' + 'version="1.1">', '</svg>'];
    function isRealTemplate(node) {
      return isTemplate(node) && node.content instanceof DocumentFragment;
    }
    var tagRE$1 = /<([\w:]+)/;
    var entityRE = /&#?\w+?;/;
    function stringToFragment(templateString, raw) {
      var hit = templateCache.get(templateString);
      if (hit) {
        return hit;
      }
      var frag = document.createDocumentFragment();
      var tagMatch = templateString.match(tagRE$1);
      var entityMatch = entityRE.test(templateString);
      if (!tagMatch && !entityMatch) {
        frag.appendChild(document.createTextNode(templateString));
      } else {
        var tag = tagMatch && tagMatch[1];
        var wrap = map[tag] || map.efault;
        var depth = wrap[0];
        var prefix = wrap[1];
        var suffix = wrap[2];
        var node = document.createElement('div');
        if (!raw) {
          templateString = templateString.trim();
        }
        node.innerHTML = prefix + templateString + suffix;
        while (depth--) {
          node = node.lastChild;
        }
        var child;
        while (child = node.firstChild) {
          frag.appendChild(child);
        }
      }
      templateCache.put(templateString, frag);
      return frag;
    }
    function nodeToFragment(node) {
      if (isRealTemplate(node)) {
        trimNode(node.content);
        return node.content;
      }
      if (node.tagName === 'SCRIPT') {
        return stringToFragment(node.textContent);
      }
      var clonedNode = cloneNode(node);
      var frag = document.createDocumentFragment();
      var child;
      while (child = clonedNode.firstChild) {
        frag.appendChild(child);
      }
      trimNode(frag);
      return frag;
    }
    var hasBrokenTemplate = (function() {
      if (inBrowser) {
        var a = document.createElement('div');
        a.innerHTML = '<template>1</template>';
        return !a.cloneNode(true).firstChild.innerHTML;
      } else {
        return false;
      }
    })();
    var hasTextareaCloneBug = (function() {
      if (inBrowser) {
        var t = document.createElement('textarea');
        t.placeholder = 't';
        return t.cloneNode(true).value === 't';
      } else {
        return false;
      }
    })();
    function cloneNode(node) {
      if (!node.querySelectorAll) {
        return node.cloneNode();
      }
      var res = node.cloneNode(true);
      var i,
          original,
          cloned;
      if (hasBrokenTemplate) {
        var tempClone = res;
        if (isRealTemplate(node)) {
          node = node.content;
          tempClone = res.content;
        }
        original = node.querySelectorAll('template');
        if (original.length) {
          cloned = tempClone.querySelectorAll('template');
          i = cloned.length;
          while (i--) {
            cloned[i].parentNode.replaceChild(cloneNode(original[i]), cloned[i]);
          }
        }
      }
      if (hasTextareaCloneBug) {
        if (node.tagName === 'TEXTAREA') {
          res.value = node.value;
        } else {
          original = node.querySelectorAll('textarea');
          if (original.length) {
            cloned = res.querySelectorAll('textarea');
            i = cloned.length;
            while (i--) {
              cloned[i].value = original[i].value;
            }
          }
        }
      }
      return res;
    }
    function parseTemplate(template, shouldClone, raw) {
      var node,
          frag;
      if (template instanceof DocumentFragment) {
        trimNode(template);
        return shouldClone ? cloneNode(template) : template;
      }
      if (typeof template === 'string') {
        if (!raw && template.charAt(0) === '#') {
          frag = idSelectorCache.get(template);
          if (!frag) {
            node = document.getElementById(template.slice(1));
            if (node) {
              frag = nodeToFragment(node);
              idSelectorCache.put(template, frag);
            }
          }
        } else {
          frag = stringToFragment(template, raw);
        }
      } else if (template.nodeType) {
        frag = nodeToFragment(template);
      }
      return frag && shouldClone ? cloneNode(frag) : frag;
    }
    var template = Object.freeze({
      cloneNode: cloneNode,
      parseTemplate: parseTemplate
    });
    function Fragment(linker, vm, frag, host, scope, parentFrag) {
      this.children = [];
      this.childFrags = [];
      this.vm = vm;
      this.scope = scope;
      this.inserted = false;
      this.parentFrag = parentFrag;
      if (parentFrag) {
        parentFrag.childFrags.push(this);
      }
      this.unlink = linker(vm, frag, host, scope, this);
      var single = this.single = frag.childNodes.length === 1 && !frag.childNodes[0].__vue_anchor;
      if (single) {
        this.node = frag.childNodes[0];
        this.before = singleBefore;
        this.remove = singleRemove;
      } else {
        this.node = createAnchor('fragment-start');
        this.end = createAnchor('fragment-end');
        this.frag = frag;
        prepend(this.node, frag);
        frag.appendChild(this.end);
        this.before = multiBefore;
        this.remove = multiRemove;
      }
      this.node.__vfrag__ = this;
    }
    Fragment.prototype.callHook = function(hook) {
      var i,
          l;
      for (i = 0, l = this.children.length; i < l; i++) {
        hook(this.children[i]);
      }
      for (i = 0, l = this.childFrags.length; i < l; i++) {
        this.childFrags[i].callHook(hook);
      }
    };
    Fragment.prototype.destroy = function() {
      if (this.parentFrag) {
        this.parentFrag.childFrags.$remove(this);
      }
      this.unlink();
    };
    function singleBefore(target, withTransition) {
      this.inserted = true;
      var method = withTransition !== false ? beforeWithTransition : before;
      method(this.node, target, this.vm);
      if (inDoc(this.node)) {
        this.callHook(attach);
      }
    }
    function singleRemove() {
      this.inserted = false;
      var shouldCallRemove = inDoc(this.node);
      var self = this;
      self.callHook(destroyChild);
      removeWithTransition(this.node, this.vm, function() {
        if (shouldCallRemove) {
          self.callHook(detach);
        }
        self.destroy();
      });
    }
    function multiBefore(target, withTransition) {
      this.inserted = true;
      var vm = this.vm;
      var method = withTransition !== false ? beforeWithTransition : before;
      mapNodeRange(this.node, this.end, function(node) {
        method(node, target, vm);
      });
      if (inDoc(this.node)) {
        this.callHook(attach);
      }
    }
    function multiRemove() {
      this.inserted = false;
      var self = this;
      var shouldCallRemove = inDoc(this.node);
      self.callHook(destroyChild);
      removeNodeRange(this.node, this.end, this.vm, this.frag, function() {
        if (shouldCallRemove) {
          self.callHook(detach);
        }
        self.destroy();
      });
    }
    function attach(child) {
      if (!child._isAttached) {
        child._callHook('attached');
      }
    }
    function destroyChild(child) {
      child.$destroy(false, true);
    }
    function detach(child) {
      if (child._isAttached) {
        child._callHook('detached');
      }
    }
    var linkerCache = new Cache(5000);
    function FragmentFactory(vm, el) {
      this.vm = vm;
      var template;
      var isString = typeof el === 'string';
      if (isString || isTemplate(el)) {
        template = parseTemplate(el, true);
      } else {
        template = document.createDocumentFragment();
        template.appendChild(el);
      }
      this.template = template;
      var linker;
      var cid = vm.constructor.cid;
      if (cid > 0) {
        var cacheId = cid + (isString ? el : el.outerHTML);
        linker = linkerCache.get(cacheId);
        if (!linker) {
          linker = compile(template, vm.$options, true);
          linkerCache.put(cacheId, linker);
        }
      } else {
        linker = compile(template, vm.$options, true);
      }
      this.linker = linker;
    }
    FragmentFactory.prototype.create = function(host, scope, parentFrag) {
      var frag = cloneNode(this.template);
      return new Fragment(this.linker, this.vm, frag, host, scope, parentFrag);
    };
    var vIf = {
      priority: IF,
      bind: function bind() {
        var el = this.el;
        if (!el.__vue__) {
          var next = el.nextElementSibling;
          if (next && getAttr(next, 'v-else') !== null) {
            remove(next);
            this.elseFactory = new FragmentFactory(this.vm, next);
          }
          this.anchor = createAnchor('v-if');
          replace(el, this.anchor);
          this.factory = new FragmentFactory(this.vm, el);
        } else {
          process.env.NODE_ENV !== 'production' && warn('v-if="' + this.expression + '" cannot be ' + 'used on an instance root element.');
          this.invalid = true;
        }
      },
      update: function update(value) {
        if (this.invalid)
          return;
        if (value) {
          if (!this.frag) {
            this.insert();
          }
        } else {
          this.remove();
        }
      },
      insert: function insert() {
        if (this.elseFrag) {
          this.elseFrag.remove();
          this.elseFrag = null;
        }
        this.frag = this.factory.create(this._host, this._scope, this._frag);
        this.frag.before(this.anchor);
      },
      remove: function remove() {
        if (this.frag) {
          this.frag.remove();
          this.frag = null;
        }
        if (this.elseFactory && !this.elseFrag) {
          this.elseFrag = this.elseFactory.create(this._host, this._scope, this._frag);
          this.elseFrag.before(this.anchor);
        }
      },
      unbind: function unbind() {
        if (this.frag) {
          this.frag.destroy();
        }
      }
    };
    var uid$1 = 0;
    var vFor = {
      priority: FOR,
      params: ['track-by', 'stagger', 'enter-stagger', 'leave-stagger'],
      bind: function bind() {
        var inMatch = this.expression.match(/(.*) in (.*)/);
        if (inMatch) {
          var itMatch = inMatch[1].match(/\((.*),(.*)\)/);
          if (itMatch) {
            this.iterator = itMatch[1].trim();
            this.alias = itMatch[2].trim();
          } else {
            this.alias = inMatch[1].trim();
          }
          this.expression = inMatch[2];
        }
        if (!this.alias) {
          process.env.NODE_ENV !== 'production' && warn('Alias is required in v-for.');
          return;
        }
        this.id = '__v-for__' + ++uid$1;
        var tag = this.el.tagName;
        this.isOption = (tag === 'OPTION' || tag === 'OPTGROUP') && this.el.parentNode.tagName === 'SELECT';
        this.start = createAnchor('v-for-start');
        this.end = createAnchor('v-for-end');
        replace(this.el, this.end);
        before(this.start, this.end);
        this.cache = Object.create(null);
        this.factory = new FragmentFactory(this.vm, this.el);
      },
      update: function update(data) {
        this.diff(data);
        this.updateRef();
        this.updateModel();
      },
      diff: function diff(data) {
        var item = data[0];
        var convertedFromObject = this.fromObject = isObject(item) && hasOwn(item, '$key') && hasOwn(item, '$value');
        var trackByKey = this.params.trackBy;
        var oldFrags = this.frags;
        var frags = this.frags = new Array(data.length);
        var alias = this.alias;
        var iterator = this.iterator;
        var start = this.start;
        var end = this.end;
        var inDocument = inDoc(start);
        var init = !oldFrags;
        var i,
            l,
            frag,
            key,
            value,
            primitive;
        for (i = 0, l = data.length; i < l; i++) {
          item = data[i];
          key = convertedFromObject ? item.$key : null;
          value = convertedFromObject ? item.$value : item;
          primitive = !isObject(value);
          frag = !init && this.getCachedFrag(value, i, key);
          if (frag) {
            frag.reused = true;
            frag.scope.$index = i;
            if (key) {
              frag.scope.$key = key;
            }
            if (iterator) {
              frag.scope[iterator] = key !== null ? key : i;
            }
            if (trackByKey || convertedFromObject || primitive) {
              frag.scope[alias] = value;
            }
          } else {
            frag = this.create(value, alias, i, key);
            frag.fresh = !init;
          }
          frags[i] = frag;
          if (init) {
            frag.before(end);
          }
        }
        if (init) {
          return;
        }
        var removalIndex = 0;
        var totalRemoved = oldFrags.length - frags.length;
        for (i = 0, l = oldFrags.length; i < l; i++) {
          frag = oldFrags[i];
          if (!frag.reused) {
            this.deleteCachedFrag(frag);
            this.remove(frag, removalIndex++, totalRemoved, inDocument);
          }
        }
        var targetPrev,
            prevEl,
            currentPrev;
        var insertionIndex = 0;
        for (i = 0, l = frags.length; i < l; i++) {
          frag = frags[i];
          targetPrev = frags[i - 1];
          prevEl = targetPrev ? targetPrev.staggerCb ? targetPrev.staggerAnchor : targetPrev.end || targetPrev.node : start;
          if (frag.reused && !frag.staggerCb) {
            currentPrev = findPrevFrag(frag, start, this.id);
            if (currentPrev !== targetPrev && (!currentPrev || findPrevFrag(currentPrev, start, this.id) !== targetPrev)) {
              this.move(frag, prevEl);
            }
          } else {
            this.insert(frag, insertionIndex++, prevEl, inDocument);
          }
          frag.reused = frag.fresh = false;
        }
      },
      create: function create(value, alias, index, key) {
        var host = this._host;
        var parentScope = this._scope || this.vm;
        var scope = Object.create(parentScope);
        scope.$refs = Object.create(parentScope.$refs);
        scope.$els = Object.create(parentScope.$els);
        scope.$parent = parentScope;
        scope.$forContext = this;
        defineReactive(scope, alias, value);
        defineReactive(scope, '$index', index);
        if (key) {
          defineReactive(scope, '$key', key);
        } else if (scope.$key) {
          def(scope, '$key', null);
        }
        if (this.iterator) {
          defineReactive(scope, this.iterator, key !== null ? key : index);
        }
        var frag = this.factory.create(host, scope, this._frag);
        frag.forId = this.id;
        this.cacheFrag(value, frag, index, key);
        return frag;
      },
      updateRef: function updateRef() {
        var ref = this.descriptor.ref;
        if (!ref)
          return;
        var hash = (this._scope || this.vm).$refs;
        var refs;
        if (!this.fromObject) {
          refs = this.frags.map(findVmFromFrag);
        } else {
          refs = {};
          this.frags.forEach(function(frag) {
            refs[frag.scope.$key] = findVmFromFrag(frag);
          });
        }
        hash[ref] = refs;
      },
      updateModel: function updateModel() {
        if (this.isOption) {
          var parent = this.start.parentNode;
          var model = parent && parent.__v_model;
          if (model) {
            model.forceUpdate();
          }
        }
      },
      insert: function insert(frag, index, prevEl, inDocument) {
        if (frag.staggerCb) {
          frag.staggerCb.cancel();
          frag.staggerCb = null;
        }
        var staggerAmount = this.getStagger(frag, index, null, 'enter');
        if (inDocument && staggerAmount) {
          var anchor = frag.staggerAnchor;
          if (!anchor) {
            anchor = frag.staggerAnchor = createAnchor('stagger-anchor');
            anchor.__vfrag__ = frag;
          }
          after(anchor, prevEl);
          var op = frag.staggerCb = cancellable(function() {
            frag.staggerCb = null;
            frag.before(anchor);
            remove(anchor);
          });
          setTimeout(op, staggerAmount);
        } else {
          frag.before(prevEl.nextSibling);
        }
      },
      remove: function remove(frag, index, total, inDocument) {
        if (frag.staggerCb) {
          frag.staggerCb.cancel();
          frag.staggerCb = null;
          return;
        }
        var staggerAmount = this.getStagger(frag, index, total, 'leave');
        if (inDocument && staggerAmount) {
          var op = frag.staggerCb = cancellable(function() {
            frag.staggerCb = null;
            frag.remove();
          });
          setTimeout(op, staggerAmount);
        } else {
          frag.remove();
        }
      },
      move: function move(frag, prevEl) {
        frag.before(prevEl.nextSibling, false);
      },
      cacheFrag: function cacheFrag(value, frag, index, key) {
        var trackByKey = this.params.trackBy;
        var cache = this.cache;
        var primitive = !isObject(value);
        var id;
        if (key || trackByKey || primitive) {
          id = trackByKey ? trackByKey === '$index' ? index : value[trackByKey] : key || value;
          if (!cache[id]) {
            cache[id] = frag;
          } else if (trackByKey !== '$index') {
            process.env.NODE_ENV !== 'production' && this.warnDuplicate(value);
          }
        } else {
          id = this.id;
          if (hasOwn(value, id)) {
            if (value[id] === null) {
              value[id] = frag;
            } else {
              process.env.NODE_ENV !== 'production' && this.warnDuplicate(value);
            }
          } else {
            def(value, id, frag);
          }
        }
        frag.raw = value;
      },
      getCachedFrag: function getCachedFrag(value, index, key) {
        var trackByKey = this.params.trackBy;
        var primitive = !isObject(value);
        var frag;
        if (key || trackByKey || primitive) {
          var id = trackByKey ? trackByKey === '$index' ? index : value[trackByKey] : key || value;
          frag = this.cache[id];
        } else {
          frag = value[this.id];
        }
        if (frag && (frag.reused || frag.fresh)) {
          process.env.NODE_ENV !== 'production' && this.warnDuplicate(value);
        }
        return frag;
      },
      deleteCachedFrag: function deleteCachedFrag(frag) {
        var value = frag.raw;
        var trackByKey = this.params.trackBy;
        var scope = frag.scope;
        var index = scope.$index;
        var key = hasOwn(scope, '$key') && scope.$key;
        var primitive = !isObject(value);
        if (trackByKey || key || primitive) {
          var id = trackByKey ? trackByKey === '$index' ? index : value[trackByKey] : key || value;
          this.cache[id] = null;
        } else {
          value[this.id] = null;
          frag.raw = null;
        }
      },
      getStagger: function getStagger(frag, index, total, type) {
        type = type + 'Stagger';
        var trans = frag.node.__v_trans;
        var hooks = trans && trans.hooks;
        var hook = hooks && (hooks[type] || hooks.stagger);
        return hook ? hook.call(frag, index, total) : index * parseInt(this.params[type] || this.params.stagger, 10);
      },
      _preProcess: function _preProcess(value) {
        this.rawValue = value;
        return value;
      },
      _postProcess: function _postProcess(value) {
        if (isArray(value)) {
          return value;
        } else if (isPlainObject(value)) {
          var keys = Object.keys(value);
          var i = keys.length;
          var res = new Array(i);
          var key;
          while (i--) {
            key = keys[i];
            res[i] = {
              $key: key,
              $value: value[key]
            };
          }
          return res;
        } else {
          if (typeof value === 'number') {
            value = range(value);
          }
          return value || [];
        }
      },
      unbind: function unbind() {
        if (this.descriptor.ref) {
          (this._scope || this.vm).$refs[this.descriptor.ref] = null;
        }
        if (this.frags) {
          var i = this.frags.length;
          var frag;
          while (i--) {
            frag = this.frags[i];
            this.deleteCachedFrag(frag);
            frag.destroy();
          }
        }
      }
    };
    function findPrevFrag(frag, anchor, id) {
      var el = frag.node.previousSibling;
      if (!el)
        return;
      frag = el.__vfrag__;
      while ((!frag || frag.forId !== id || !frag.inserted) && el !== anchor) {
        el = el.previousSibling;
        if (!el)
          return;
        frag = el.__vfrag__;
      }
      return frag;
    }
    function findVmFromFrag(frag) {
      var node = frag.node;
      if (frag.end) {
        while (!node.__vue__ && node !== frag.end && node.nextSibling) {
          node = node.nextSibling;
        }
      }
      return node.__vue__;
    }
    function range(n) {
      var i = -1;
      var ret = new Array(n);
      while (++i < n) {
        ret[i] = i;
      }
      return ret;
    }
    if (process.env.NODE_ENV !== 'production') {
      vFor.warnDuplicate = function(value) {
        warn('Duplicate value found in v-for="' + this.descriptor.raw + '": ' + JSON.stringify(value) + '. Use track-by="$index" if ' + 'you are expecting duplicate values.');
      };
    }
    var html = {
      bind: function bind() {
        if (this.el.nodeType === 8) {
          this.nodes = [];
          this.anchor = createAnchor('v-html');
          replace(this.el, this.anchor);
        }
      },
      update: function update(value) {
        value = _toString(value);
        if (this.nodes) {
          this.swap(value);
        } else {
          this.el.innerHTML = value;
        }
      },
      swap: function swap(value) {
        var i = this.nodes.length;
        while (i--) {
          remove(this.nodes[i]);
        }
        var frag = parseTemplate(value, true, true);
        this.nodes = toArray(frag.childNodes);
        before(frag, this.anchor);
      }
    };
    var text = {
      bind: function bind() {
        this.attr = this.el.nodeType === 3 ? 'data' : 'textContent';
      },
      update: function update(value) {
        this.el[this.attr] = _toString(value);
      }
    };
    var publicDirectives = {
      text: text,
      html: html,
      'for': vFor,
      'if': vIf,
      show: show,
      model: model,
      on: on,
      bind: bind,
      el: el,
      ref: ref,
      cloak: cloak
    };
    var queue$1 = [];
    var queued = false;
    function pushJob(job) {
      queue$1.push(job);
      if (!queued) {
        queued = true;
        nextTick(flush);
      }
    }
    function flush() {
      var f = document.documentElement.offsetHeight;
      for (var i = 0; i < queue$1.length; i++) {
        queue$1[i]();
      }
      queue$1 = [];
      queued = false;
      return f;
    }
    var TYPE_TRANSITION = 1;
    var TYPE_ANIMATION = 2;
    var transDurationProp = transitionProp + 'Duration';
    var animDurationProp = animationProp + 'Duration';
    function Transition(el, id, hooks, vm) {
      this.id = id;
      this.el = el;
      this.enterClass = id + '-enter';
      this.leaveClass = id + '-leave';
      this.hooks = hooks;
      this.vm = vm;
      this.pendingCssEvent = this.pendingCssCb = this.cancel = this.pendingJsCb = this.op = this.cb = null;
      this.justEntered = false;
      this.entered = this.left = false;
      this.typeCache = {};
      var self = this;
      ['enterNextTick', 'enterDone', 'leaveNextTick', 'leaveDone'].forEach(function(m) {
        self[m] = bind$1(self[m], self);
      });
    }
    var p$1 = Transition.prototype;
    p$1.enter = function(op, cb) {
      this.cancelPending();
      this.callHook('beforeEnter');
      this.cb = cb;
      addClass(this.el, this.enterClass);
      op();
      this.entered = false;
      this.callHookWithCb('enter');
      if (this.entered) {
        return;
      }
      this.cancel = this.hooks && this.hooks.enterCancelled;
      pushJob(this.enterNextTick);
    };
    p$1.enterNextTick = function() {
      this.justEntered = true;
      var self = this;
      setTimeout(function() {
        self.justEntered = false;
      }, 17);
      var enterDone = this.enterDone;
      var type = this.getCssTransitionType(this.enterClass);
      if (!this.pendingJsCb) {
        if (type === TYPE_TRANSITION) {
          removeClass(this.el, this.enterClass);
          this.setupCssCb(transitionEndEvent, enterDone);
        } else if (type === TYPE_ANIMATION) {
          this.setupCssCb(animationEndEvent, enterDone);
        } else {
          enterDone();
        }
      } else if (type === TYPE_TRANSITION) {
        removeClass(this.el, this.enterClass);
      }
    };
    p$1.enterDone = function() {
      this.entered = true;
      this.cancel = this.pendingJsCb = null;
      removeClass(this.el, this.enterClass);
      this.callHook('afterEnter');
      if (this.cb)
        this.cb();
    };
    p$1.leave = function(op, cb) {
      this.cancelPending();
      this.callHook('beforeLeave');
      this.op = op;
      this.cb = cb;
      addClass(this.el, this.leaveClass);
      this.left = false;
      this.callHookWithCb('leave');
      if (this.left) {
        return;
      }
      this.cancel = this.hooks && this.hooks.leaveCancelled;
      if (this.op && !this.pendingJsCb) {
        if (this.justEntered) {
          this.leaveDone();
        } else {
          pushJob(this.leaveNextTick);
        }
      }
    };
    p$1.leaveNextTick = function() {
      var type = this.getCssTransitionType(this.leaveClass);
      if (type) {
        var event = type === TYPE_TRANSITION ? transitionEndEvent : animationEndEvent;
        this.setupCssCb(event, this.leaveDone);
      } else {
        this.leaveDone();
      }
    };
    p$1.leaveDone = function() {
      this.left = true;
      this.cancel = this.pendingJsCb = null;
      this.op();
      removeClass(this.el, this.leaveClass);
      this.callHook('afterLeave');
      if (this.cb)
        this.cb();
      this.op = null;
    };
    p$1.cancelPending = function() {
      this.op = this.cb = null;
      var hasPending = false;
      if (this.pendingCssCb) {
        hasPending = true;
        off(this.el, this.pendingCssEvent, this.pendingCssCb);
        this.pendingCssEvent = this.pendingCssCb = null;
      }
      if (this.pendingJsCb) {
        hasPending = true;
        this.pendingJsCb.cancel();
        this.pendingJsCb = null;
      }
      if (hasPending) {
        removeClass(this.el, this.enterClass);
        removeClass(this.el, this.leaveClass);
      }
      if (this.cancel) {
        this.cancel.call(this.vm, this.el);
        this.cancel = null;
      }
    };
    p$1.callHook = function(type) {
      if (this.hooks && this.hooks[type]) {
        this.hooks[type].call(this.vm, this.el);
      }
    };
    p$1.callHookWithCb = function(type) {
      var hook = this.hooks && this.hooks[type];
      if (hook) {
        if (hook.length > 1) {
          this.pendingJsCb = cancellable(this[type + 'Done']);
        }
        hook.call(this.vm, this.el, this.pendingJsCb);
      }
    };
    p$1.getCssTransitionType = function(className) {
      if (!transitionEndEvent || document.hidden || this.hooks && this.hooks.css === false || isHidden(this.el)) {
        return;
      }
      var type = this.typeCache[className];
      if (type)
        return type;
      var inlineStyles = this.el.style;
      var computedStyles = window.getComputedStyle(this.el);
      var transDuration = inlineStyles[transDurationProp] || computedStyles[transDurationProp];
      if (transDuration && transDuration !== '0s') {
        type = TYPE_TRANSITION;
      } else {
        var animDuration = inlineStyles[animDurationProp] || computedStyles[animDurationProp];
        if (animDuration && animDuration !== '0s') {
          type = TYPE_ANIMATION;
        }
      }
      if (type) {
        this.typeCache[className] = type;
      }
      return type;
    };
    p$1.setupCssCb = function(event, cb) {
      this.pendingCssEvent = event;
      var self = this;
      var el = this.el;
      var onEnd = this.pendingCssCb = function(e) {
        if (e.target === el) {
          off(el, event, onEnd);
          self.pendingCssEvent = self.pendingCssCb = null;
          if (!self.pendingJsCb && cb) {
            cb();
          }
        }
      };
      on$1(el, event, onEnd);
    };
    function isHidden(el) {
      return !(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    }
    var transition = {
      priority: TRANSITION,
      update: function update(id, oldId) {
        var el = this.el;
        var hooks = resolveAsset(this.vm.$options, 'transitions', id);
        id = id || 'v';
        el.__v_trans = new Transition(el, id, hooks, this.el.__vue__ || this.vm);
        if (oldId) {
          removeClass(el, oldId + '-transition');
        }
        addClass(el, id + '-transition');
      }
    };
    var bindingModes = config._propBindingModes;
    var propDef = {
      bind: function bind() {
        var child = this.vm;
        var parent = child._context;
        var prop = this.descriptor.prop;
        var childKey = prop.path;
        var parentKey = prop.parentPath;
        var twoWay = prop.mode === bindingModes.TWO_WAY;
        var parentWatcher = this.parentWatcher = new Watcher(parent, parentKey, function(val) {
          val = coerceProp(prop, val);
          if (assertProp(prop, val)) {
            child[childKey] = val;
          }
        }, {
          twoWay: twoWay,
          filters: prop.filters,
          scope: this._scope
        });
        initProp(child, prop, parentWatcher.value);
        if (twoWay) {
          var self = this;
          child.$once('pre-hook:created', function() {
            self.childWatcher = new Watcher(child, childKey, function(val) {
              parentWatcher.set(val);
            }, {sync: true});
          });
        }
      },
      unbind: function unbind() {
        this.parentWatcher.teardown();
        if (this.childWatcher) {
          this.childWatcher.teardown();
        }
      }
    };
    var component = {
      priority: COMPONENT,
      params: ['keep-alive', 'transition-mode', 'inline-template'],
      bind: function bind() {
        if (!this.el.__vue__) {
          this.keepAlive = this.params.keepAlive;
          if (this.keepAlive) {
            this.cache = {};
          }
          if (this.params.inlineTemplate) {
            this.inlineTemplate = extractContent(this.el, true);
          }
          this.pendingComponentCb = this.Component = null;
          this.pendingRemovals = 0;
          this.pendingRemovalCb = null;
          this.anchor = createAnchor('v-component');
          replace(this.el, this.anchor);
          this.el.removeAttribute('is');
          if (this.descriptor.ref) {
            this.el.removeAttribute('v-ref:' + hyphenate(this.descriptor.ref));
          }
          if (this.literal) {
            this.setComponent(this.expression);
          }
        } else {
          process.env.NODE_ENV !== 'production' && warn('cannot mount component "' + this.expression + '" ' + 'on already mounted element: ' + this.el);
        }
      },
      update: function update(value) {
        if (!this.literal) {
          this.setComponent(value);
        }
      },
      setComponent: function setComponent(value, cb) {
        this.invalidatePending();
        if (!value) {
          this.unbuild(true);
          this.remove(this.childVM, cb);
          this.childVM = null;
        } else {
          var self = this;
          this.resolveComponent(value, function() {
            self.mountComponent(cb);
          });
        }
      },
      resolveComponent: function resolveComponent(id, cb) {
        var self = this;
        this.pendingComponentCb = cancellable(function(Component) {
          self.ComponentName = Component.options.name || id;
          self.Component = Component;
          cb();
        });
        this.vm._resolveComponent(id, this.pendingComponentCb);
      },
      mountComponent: function mountComponent(cb) {
        this.unbuild(true);
        var self = this;
        var activateHook = this.Component.options.activate;
        var cached = this.getCached();
        var newComponent = this.build();
        if (activateHook && !cached) {
          this.waitingFor = newComponent;
          activateHook.call(newComponent, function() {
            if (self.waitingFor !== newComponent) {
              return;
            }
            self.waitingFor = null;
            self.transition(newComponent, cb);
          });
        } else {
          if (cached) {
            newComponent._updateRef();
          }
          this.transition(newComponent, cb);
        }
      },
      invalidatePending: function invalidatePending() {
        if (this.pendingComponentCb) {
          this.pendingComponentCb.cancel();
          this.pendingComponentCb = null;
        }
      },
      build: function build(extraOptions) {
        var cached = this.getCached();
        if (cached) {
          return cached;
        }
        if (this.Component) {
          var options = {
            name: this.ComponentName,
            el: cloneNode(this.el),
            template: this.inlineTemplate,
            parent: this._host || this.vm,
            _linkerCachable: !this.inlineTemplate,
            _ref: this.descriptor.ref,
            _asComponent: true,
            _isRouterView: this._isRouterView,
            _context: this.vm,
            _scope: this._scope,
            _frag: this._frag
          };
          if (extraOptions) {
            extend(options, extraOptions);
          }
          var child = new this.Component(options);
          if (this.keepAlive) {
            this.cache[this.Component.cid] = child;
          }
          if (process.env.NODE_ENV !== 'production' && this.el.hasAttribute('transition') && child._isFragment) {
            warn('Transitions will not work on a fragment instance. ' + 'Template: ' + child.$options.template);
          }
          return child;
        }
      },
      getCached: function getCached() {
        return this.keepAlive && this.cache[this.Component.cid];
      },
      unbuild: function unbuild(defer) {
        if (this.waitingFor) {
          this.waitingFor.$destroy();
          this.waitingFor = null;
        }
        var child = this.childVM;
        if (!child || this.keepAlive) {
          if (child) {
            child._updateRef(true);
          }
          return;
        }
        child.$destroy(false, defer);
      },
      remove: function remove(child, cb) {
        var keepAlive = this.keepAlive;
        if (child) {
          this.pendingRemovals++;
          this.pendingRemovalCb = cb;
          var self = this;
          child.$remove(function() {
            self.pendingRemovals--;
            if (!keepAlive)
              child._cleanup();
            if (!self.pendingRemovals && self.pendingRemovalCb) {
              self.pendingRemovalCb();
              self.pendingRemovalCb = null;
            }
          });
        } else if (cb) {
          cb();
        }
      },
      transition: function transition(target, cb) {
        var self = this;
        var current = this.childVM;
        if (process.env.NODE_ENV !== 'production') {
          if (current)
            current._inactive = true;
          target._inactive = false;
        }
        this.childVM = target;
        switch (self.params.transitionMode) {
          case 'in-out':
            target.$before(self.anchor, function() {
              self.remove(current, cb);
            });
            break;
          case 'out-in':
            self.remove(current, function() {
              target.$before(self.anchor, cb);
            });
            break;
          default:
            self.remove(current);
            target.$before(self.anchor, cb);
        }
      },
      unbind: function unbind() {
        this.invalidatePending();
        this.unbuild();
        if (this.cache) {
          for (var key in this.cache) {
            this.cache[key].$destroy();
          }
          this.cache = null;
        }
      }
    };
    var vClass = {
      deep: true,
      update: function update(value) {
        if (value && typeof value === 'string') {
          this.handleObject(stringToObject(value));
        } else if (isPlainObject(value)) {
          this.handleObject(value);
        } else if (isArray(value)) {
          this.handleArray(value);
        } else {
          this.cleanup();
        }
      },
      handleObject: function handleObject(value) {
        this.cleanup(value);
        var keys = this.prevKeys = Object.keys(value);
        for (var i = 0,
            l = keys.length; i < l; i++) {
          var key = keys[i];
          if (value[key]) {
            addClass(this.el, key);
          } else {
            removeClass(this.el, key);
          }
        }
      },
      handleArray: function handleArray(value) {
        this.cleanup(value);
        for (var i = 0,
            l = value.length; i < l; i++) {
          if (value[i]) {
            addClass(this.el, value[i]);
          }
        }
        this.prevKeys = value.slice();
      },
      cleanup: function cleanup(value) {
        if (this.prevKeys) {
          var i = this.prevKeys.length;
          while (i--) {
            var key = this.prevKeys[i];
            if (key && (!value || !contains$1(value, key))) {
              removeClass(this.el, key);
            }
          }
        }
      }
    };
    function stringToObject(value) {
      var res = {};
      var keys = value.trim().split(/\s+/);
      var i = keys.length;
      while (i--) {
        res[keys[i]] = true;
      }
      return res;
    }
    function contains$1(value, key) {
      return isArray(value) ? value.indexOf(key) > -1 : hasOwn(value, key);
    }
    var internalDirectives = {
      style: style,
      'class': vClass,
      component: component,
      prop: propDef,
      transition: transition
    };
    var propBindingModes = config._propBindingModes;
    var empty = {};
    var identRE$1 = /^[$_a-zA-Z]+[\w$]*$/;
    var settablePathRE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*|\[[^\[\]]+\])*$/;
    function compileProps(el, propOptions) {
      var props = [];
      var names = Object.keys(propOptions);
      var i = names.length;
      var options,
          name,
          attr,
          value,
          path,
          parsed,
          prop;
      while (i--) {
        name = names[i];
        options = propOptions[name] || empty;
        if (process.env.NODE_ENV !== 'production' && name === '$data') {
          warn('Do not use $data as prop.');
          continue;
        }
        path = camelize(name);
        if (!identRE$1.test(path)) {
          process.env.NODE_ENV !== 'production' && warn('Invalid prop key: "' + name + '". Prop keys ' + 'must be valid identifiers.');
          continue;
        }
        prop = {
          name: name,
          path: path,
          options: options,
          mode: propBindingModes.ONE_WAY,
          raw: null
        };
        attr = hyphenate(name);
        if ((value = getBindAttr(el, attr)) === null) {
          if ((value = getBindAttr(el, attr + '.sync')) !== null) {
            prop.mode = propBindingModes.TWO_WAY;
          } else if ((value = getBindAttr(el, attr + '.once')) !== null) {
            prop.mode = propBindingModes.ONE_TIME;
          }
        }
        if (value !== null) {
          prop.raw = value;
          parsed = parseDirective(value);
          value = parsed.expression;
          prop.filters = parsed.filters;
          if (isLiteral(value)) {
            prop.optimizedLiteral = true;
          } else {
            prop.dynamic = true;
            if (process.env.NODE_ENV !== 'production' && prop.mode === propBindingModes.TWO_WAY && !settablePathRE.test(value)) {
              prop.mode = propBindingModes.ONE_WAY;
              warn('Cannot bind two-way prop with non-settable ' + 'parent path: ' + value);
            }
          }
          prop.parentPath = value;
          if (process.env.NODE_ENV !== 'production' && options.twoWay && prop.mode !== propBindingModes.TWO_WAY) {
            warn('Prop "' + name + '" expects a two-way binding type.');
          }
        } else if ((value = getAttr(el, attr)) !== null) {
          prop.raw = value;
        } else if (options.required) {
          process.env.NODE_ENV !== 'production' && warn('Missing required prop: ' + name);
        }
        props.push(prop);
      }
      return makePropsLinkFn(props);
    }
    function makePropsLinkFn(props) {
      return function propsLinkFn(vm, scope) {
        vm._props = {};
        var i = props.length;
        var prop,
            path,
            options,
            value,
            raw;
        while (i--) {
          prop = props[i];
          raw = prop.raw;
          path = prop.path;
          options = prop.options;
          vm._props[path] = prop;
          if (raw === null) {
            initProp(vm, prop, getDefault(vm, options));
          } else if (prop.dynamic) {
            if (vm._context) {
              if (prop.mode === propBindingModes.ONE_TIME) {
                value = (scope || vm._context).$get(prop.parentPath);
                initProp(vm, prop, value);
              } else {
                vm._bindDir({
                  name: 'prop',
                  def: propDef,
                  prop: prop
                }, null, null, scope);
              }
            } else {
              process.env.NODE_ENV !== 'production' && warn('Cannot bind dynamic prop on a root instance' + ' with no parent: ' + prop.name + '="' + raw + '"');
            }
          } else if (prop.optimizedLiteral) {
            var stripped = stripQuotes(raw);
            value = stripped === raw ? toBoolean(toNumber(raw)) : stripped;
            initProp(vm, prop, value);
          } else {
            value = options.type === Boolean && raw === '' ? true : raw;
            initProp(vm, prop, value);
          }
        }
      };
    }
    function getDefault(vm, options) {
      if (!hasOwn(options, 'default')) {
        return options.type === Boolean ? false : undefined;
      }
      var def = options['default'];
      if (isObject(def)) {
        process.env.NODE_ENV !== 'production' && warn('Object/Array as default prop values will be shared ' + 'across multiple instances. Use a factory function ' + 'to return the default value instead.');
      }
      return typeof def === 'function' && options.type !== Function ? def.call(vm) : def;
    }
    var bindRE = /^v-bind:|^:/;
    var onRE = /^v-on:|^@/;
    var argRE = /:(.*)$/;
    var modifierRE = /\.[^\.]+/g;
    var transitionRE = /^(v-bind:|:)?transition$/;
    var terminalDirectives = ['for', 'if'];
    var DEFAULT_PRIORITY = 1000;
    function compile(el, options, partial) {
      var nodeLinkFn = partial || !options._asComponent ? compileNode(el, options) : null;
      var childLinkFn = !(nodeLinkFn && nodeLinkFn.terminal) && el.tagName !== 'SCRIPT' && el.hasChildNodes() ? compileNodeList(el.childNodes, options) : null;
      return function compositeLinkFn(vm, el, host, scope, frag) {
        var childNodes = toArray(el.childNodes);
        var dirs = linkAndCapture(function compositeLinkCapturer() {
          if (nodeLinkFn)
            nodeLinkFn(vm, el, host, scope, frag);
          if (childLinkFn)
            childLinkFn(vm, childNodes, host, scope, frag);
        }, vm);
        return makeUnlinkFn(vm, dirs);
      };
    }
    function linkAndCapture(linker, vm) {
      var originalDirCount = vm._directives.length;
      linker();
      var dirs = vm._directives.slice(originalDirCount);
      dirs.sort(directiveComparator);
      for (var i = 0,
          l = dirs.length; i < l; i++) {
        dirs[i]._bind();
      }
      return dirs;
    }
    function directiveComparator(a, b) {
      a = a.descriptor.def.priority || DEFAULT_PRIORITY;
      b = b.descriptor.def.priority || DEFAULT_PRIORITY;
      return a > b ? -1 : a === b ? 0 : 1;
    }
    function makeUnlinkFn(vm, dirs, context, contextDirs) {
      return function unlink(destroying) {
        teardownDirs(vm, dirs, destroying);
        if (context && contextDirs) {
          teardownDirs(context, contextDirs);
        }
      };
    }
    function teardownDirs(vm, dirs, destroying) {
      var i = dirs.length;
      while (i--) {
        dirs[i]._teardown();
        if (!destroying) {
          vm._directives.$remove(dirs[i]);
        }
      }
    }
    function compileAndLinkProps(vm, el, props, scope) {
      var propsLinkFn = compileProps(el, props);
      var propDirs = linkAndCapture(function() {
        propsLinkFn(vm, scope);
      }, vm);
      return makeUnlinkFn(vm, propDirs);
    }
    function compileRoot(el, options, contextOptions) {
      var containerAttrs = options._containerAttrs;
      var replacerAttrs = options._replacerAttrs;
      var contextLinkFn,
          replacerLinkFn;
      if (el.nodeType !== 11) {
        if (options._asComponent) {
          if (containerAttrs && contextOptions) {
            contextLinkFn = compileDirectives(containerAttrs, contextOptions);
          }
          if (replacerAttrs) {
            replacerLinkFn = compileDirectives(replacerAttrs, options);
          }
        } else {
          replacerLinkFn = compileDirectives(el.attributes, options);
        }
      } else if (process.env.NODE_ENV !== 'production' && containerAttrs) {
        var names = containerAttrs.filter(function(attr) {
          return attr.name.indexOf('_v-') < 0 && !onRE.test(attr.name) && attr.name !== 'slot';
        }).map(function(attr) {
          return '"' + attr.name + '"';
        });
        if (names.length) {
          var plural = names.length > 1;
          warn('Attribute' + (plural ? 's ' : ' ') + names.join(', ') + (plural ? ' are' : ' is') + ' ignored on component ' + '<' + options.el.tagName.toLowerCase() + '> because ' + 'the component is a fragment instance: ' + 'http://vuejs.org/guide/components.html#Fragment_Instance');
        }
      }
      return function rootLinkFn(vm, el, scope) {
        var context = vm._context;
        var contextDirs;
        if (context && contextLinkFn) {
          contextDirs = linkAndCapture(function() {
            contextLinkFn(context, el, null, scope);
          }, context);
        }
        var selfDirs = linkAndCapture(function() {
          if (replacerLinkFn)
            replacerLinkFn(vm, el);
        }, vm);
        return makeUnlinkFn(vm, selfDirs, context, contextDirs);
      };
    }
    function compileNode(node, options) {
      var type = node.nodeType;
      if (type === 1 && node.tagName !== 'SCRIPT') {
        return compileElement(node, options);
      } else if (type === 3 && node.data.trim()) {
        return compileTextNode(node, options);
      } else {
        return null;
      }
    }
    function compileElement(el, options) {
      if (el.tagName === 'TEXTAREA') {
        var tokens = parseText(el.value);
        if (tokens) {
          el.setAttribute(':value', tokensToExp(tokens));
          el.value = '';
        }
      }
      var linkFn;
      var hasAttrs = el.hasAttributes();
      if (hasAttrs) {
        linkFn = checkTerminalDirectives(el, options);
      }
      if (!linkFn) {
        linkFn = checkElementDirectives(el, options);
      }
      if (!linkFn) {
        linkFn = checkComponent(el, options);
      }
      if (!linkFn && hasAttrs) {
        linkFn = compileDirectives(el.attributes, options);
      }
      return linkFn;
    }
    function compileTextNode(node, options) {
      if (node._skip) {
        return removeText;
      }
      var tokens = parseText(node.wholeText);
      if (!tokens) {
        return null;
      }
      var next = node.nextSibling;
      while (next && next.nodeType === 3) {
        next._skip = true;
        next = next.nextSibling;
      }
      var frag = document.createDocumentFragment();
      var el,
          token;
      for (var i = 0,
          l = tokens.length; i < l; i++) {
        token = tokens[i];
        el = token.tag ? processTextToken(token, options) : document.createTextNode(token.value);
        frag.appendChild(el);
      }
      return makeTextNodeLinkFn(tokens, frag, options);
    }
    function removeText(vm, node) {
      remove(node);
    }
    function processTextToken(token, options) {
      var el;
      if (token.oneTime) {
        el = document.createTextNode(token.value);
      } else {
        if (token.html) {
          el = document.createComment('v-html');
          setTokenType('html');
        } else {
          el = document.createTextNode(' ');
          setTokenType('text');
        }
      }
      function setTokenType(type) {
        if (token.descriptor)
          return;
        var parsed = parseDirective(token.value);
        token.descriptor = {
          name: type,
          def: publicDirectives[type],
          expression: parsed.expression,
          filters: parsed.filters
        };
      }
      return el;
    }
    function makeTextNodeLinkFn(tokens, frag) {
      return function textNodeLinkFn(vm, el, host, scope) {
        var fragClone = frag.cloneNode(true);
        var childNodes = toArray(fragClone.childNodes);
        var token,
            value,
            node;
        for (var i = 0,
            l = tokens.length; i < l; i++) {
          token = tokens[i];
          value = token.value;
          if (token.tag) {
            node = childNodes[i];
            if (token.oneTime) {
              value = (scope || vm).$eval(value);
              if (token.html) {
                replace(node, parseTemplate(value, true));
              } else {
                node.data = value;
              }
            } else {
              vm._bindDir(token.descriptor, node, host, scope);
            }
          }
        }
        replace(el, fragClone);
      };
    }
    function compileNodeList(nodeList, options) {
      var linkFns = [];
      var nodeLinkFn,
          childLinkFn,
          node;
      for (var i = 0,
          l = nodeList.length; i < l; i++) {
        node = nodeList[i];
        nodeLinkFn = compileNode(node, options);
        childLinkFn = !(nodeLinkFn && nodeLinkFn.terminal) && node.tagName !== 'SCRIPT' && node.hasChildNodes() ? compileNodeList(node.childNodes, options) : null;
        linkFns.push(nodeLinkFn, childLinkFn);
      }
      return linkFns.length ? makeChildLinkFn(linkFns) : null;
    }
    function makeChildLinkFn(linkFns) {
      return function childLinkFn(vm, nodes, host, scope, frag) {
        var node,
            nodeLinkFn,
            childrenLinkFn;
        for (var i = 0,
            n = 0,
            l = linkFns.length; i < l; n++) {
          node = nodes[n];
          nodeLinkFn = linkFns[i++];
          childrenLinkFn = linkFns[i++];
          var childNodes = toArray(node.childNodes);
          if (nodeLinkFn) {
            nodeLinkFn(vm, node, host, scope, frag);
          }
          if (childrenLinkFn) {
            childrenLinkFn(vm, childNodes, host, scope, frag);
          }
        }
      };
    }
    function checkElementDirectives(el, options) {
      var tag = el.tagName.toLowerCase();
      if (commonTagRE.test(tag))
        return;
      if (tag === 'slot' && hasBindAttr(el, 'name')) {
        tag = '_namedSlot';
      }
      var def = resolveAsset(options, 'elementDirectives', tag);
      if (def) {
        return makeTerminalNodeLinkFn(el, tag, '', options, def);
      }
    }
    function checkComponent(el, options) {
      var component = checkComponentAttr(el, options);
      if (component) {
        var ref = findRef(el);
        var descriptor = {
          name: 'component',
          ref: ref,
          expression: component.id,
          def: internalDirectives.component,
          modifiers: {literal: !component.dynamic}
        };
        var componentLinkFn = function componentLinkFn(vm, el, host, scope, frag) {
          if (ref) {
            defineReactive((scope || vm).$refs, ref, null);
          }
          vm._bindDir(descriptor, el, host, scope, frag);
        };
        componentLinkFn.terminal = true;
        return componentLinkFn;
      }
    }
    function checkTerminalDirectives(el, options) {
      if (getAttr(el, 'v-pre') !== null) {
        return skip;
      }
      if (el.hasAttribute('v-else')) {
        var prev = el.previousElementSibling;
        if (prev && prev.hasAttribute('v-if')) {
          return skip;
        }
      }
      var value,
          dirName;
      for (var i = 0,
          l = terminalDirectives.length; i < l; i++) {
        dirName = terminalDirectives[i];
        if (value = el.getAttribute('v-' + dirName)) {
          return makeTerminalNodeLinkFn(el, dirName, value, options);
        }
      }
    }
    function skip() {}
    skip.terminal = true;
    function makeTerminalNodeLinkFn(el, dirName, value, options, def) {
      var parsed = parseDirective(value);
      var descriptor = {
        name: dirName,
        expression: parsed.expression,
        filters: parsed.filters,
        raw: value,
        def: def || publicDirectives[dirName]
      };
      if (dirName === 'for' || dirName === 'router-view') {
        descriptor.ref = findRef(el);
      }
      var fn = function terminalNodeLinkFn(vm, el, host, scope, frag) {
        if (descriptor.ref) {
          defineReactive((scope || vm).$refs, descriptor.ref, null);
        }
        vm._bindDir(descriptor, el, host, scope, frag);
      };
      fn.terminal = true;
      return fn;
    }
    function compileDirectives(attrs, options) {
      var i = attrs.length;
      var dirs = [];
      var attr,
          name,
          value,
          rawName,
          rawValue,
          dirName,
          arg,
          modifiers,
          dirDef,
          tokens;
      while (i--) {
        attr = attrs[i];
        name = rawName = attr.name;
        value = rawValue = attr.value;
        tokens = parseText(value);
        arg = null;
        modifiers = parseModifiers(name);
        name = name.replace(modifierRE, '');
        if (tokens) {
          value = tokensToExp(tokens);
          arg = name;
          pushDir('bind', publicDirectives.bind, true);
          if (process.env.NODE_ENV !== 'production') {
            if (name === 'class' && Array.prototype.some.call(attrs, function(attr) {
              return attr.name === ':class' || attr.name === 'v-bind:class';
            })) {
              warn('class="' + rawValue + '": Do not mix mustache interpolation ' + 'and v-bind for "class" on the same element. Use one or the other.');
            }
          }
        } else if (transitionRE.test(name)) {
          modifiers.literal = !bindRE.test(name);
          pushDir('transition', internalDirectives.transition);
        } else if (onRE.test(name)) {
          arg = name.replace(onRE, '');
          pushDir('on', publicDirectives.on);
        } else if (bindRE.test(name)) {
          dirName = name.replace(bindRE, '');
          if (dirName === 'style' || dirName === 'class') {
            pushDir(dirName, internalDirectives[dirName]);
          } else {
            arg = dirName;
            pushDir('bind', publicDirectives.bind);
          }
        } else if (name.indexOf('v-') === 0) {
          arg = (arg = name.match(argRE)) && arg[1];
          if (arg) {
            name = name.replace(argRE, '');
          }
          dirName = name.slice(2);
          if (dirName === 'else') {
            continue;
          }
          dirDef = resolveAsset(options, 'directives', dirName);
          if (process.env.NODE_ENV !== 'production') {
            assertAsset(dirDef, 'directive', dirName);
          }
          if (dirDef) {
            pushDir(dirName, dirDef);
          }
        }
      }
      function pushDir(dirName, def, interp) {
        var parsed = parseDirective(value);
        dirs.push({
          name: dirName,
          attr: rawName,
          raw: rawValue,
          def: def,
          arg: arg,
          modifiers: modifiers,
          expression: parsed.expression,
          filters: parsed.filters,
          interp: interp
        });
      }
      if (dirs.length) {
        return makeNodeLinkFn(dirs);
      }
    }
    function parseModifiers(name) {
      var res = Object.create(null);
      var match = name.match(modifierRE);
      if (match) {
        var i = match.length;
        while (i--) {
          res[match[i].slice(1)] = true;
        }
      }
      return res;
    }
    function makeNodeLinkFn(directives) {
      return function nodeLinkFn(vm, el, host, scope, frag) {
        var i = directives.length;
        while (i--) {
          vm._bindDir(directives[i], el, host, scope, frag);
        }
      };
    }
    var specialCharRE = /[^\w\-:\.]/;
    function transclude(el, options) {
      if (options) {
        options._containerAttrs = extractAttrs(el);
      }
      if (isTemplate(el)) {
        el = parseTemplate(el);
      }
      if (options) {
        if (options._asComponent && !options.template) {
          options.template = '<slot></slot>';
        }
        if (options.template) {
          options._content = extractContent(el);
          el = transcludeTemplate(el, options);
        }
      }
      if (el instanceof DocumentFragment) {
        prepend(createAnchor('v-start', true), el);
        el.appendChild(createAnchor('v-end', true));
      }
      return el;
    }
    function transcludeTemplate(el, options) {
      var template = options.template;
      var frag = parseTemplate(template, true);
      if (frag) {
        var replacer = frag.firstChild;
        var tag = replacer.tagName && replacer.tagName.toLowerCase();
        if (options.replace) {
          if (el === document.body) {
            process.env.NODE_ENV !== 'production' && warn('You are mounting an instance with a template to ' + '<body>. This will replace <body> entirely. You ' + 'should probably use `replace: false` here.');
          }
          if (frag.childNodes.length > 1 || replacer.nodeType !== 1 || tag === 'component' || resolveAsset(options, 'components', tag) || hasBindAttr(replacer, 'is') || resolveAsset(options, 'elementDirectives', tag) || replacer.hasAttribute('v-for') || replacer.hasAttribute('v-if')) {
            return frag;
          } else {
            options._replacerAttrs = extractAttrs(replacer);
            mergeAttrs(el, replacer);
            return replacer;
          }
        } else {
          el.appendChild(frag);
          return el;
        }
      } else {
        process.env.NODE_ENV !== 'production' && warn('Invalid template option: ' + template);
      }
    }
    function extractAttrs(el) {
      if (el.nodeType === 1 && el.hasAttributes()) {
        return toArray(el.attributes);
      }
    }
    function mergeAttrs(from, to) {
      var attrs = from.attributes;
      var i = attrs.length;
      var name,
          value;
      while (i--) {
        name = attrs[i].name;
        value = attrs[i].value;
        if (!to.hasAttribute(name) && !specialCharRE.test(name)) {
          to.setAttribute(name, value);
        } else if (name === 'class') {
          value.split(/\s+/).forEach(function(cls) {
            addClass(to, cls);
          });
        }
      }
    }
    var compiler = Object.freeze({
      compile: compile,
      compileAndLinkProps: compileAndLinkProps,
      compileRoot: compileRoot,
      transclude: transclude
    });
    function stateMixin(Vue) {
      Object.defineProperty(Vue.prototype, '$data', {
        get: function get() {
          return this._data;
        },
        set: function set(newData) {
          if (newData !== this._data) {
            this._setData(newData);
          }
        }
      });
      Vue.prototype._initState = function() {
        this._initProps();
        this._initMeta();
        this._initMethods();
        this._initData();
        this._initComputed();
      };
      Vue.prototype._initProps = function() {
        var options = this.$options;
        var el = options.el;
        var props = options.props;
        if (props && !el) {
          process.env.NODE_ENV !== 'production' && warn('Props will not be compiled if no `el` option is ' + 'provided at instantiation.');
        }
        el = options.el = query(el);
        this._propsUnlinkFn = el && el.nodeType === 1 && props ? compileAndLinkProps(this, el, props, this._scope) : null;
      };
      Vue.prototype._initData = function() {
        var propsData = this._data;
        var optionsDataFn = this.$options.data;
        var optionsData = optionsDataFn && optionsDataFn();
        if (optionsData) {
          this._data = optionsData;
          for (var prop in propsData) {
            if (process.env.NODE_ENV !== 'production' && hasOwn(optionsData, prop)) {
              warn('Data field "' + prop + '" is already defined ' + 'as a prop. Use prop default value instead.');
            }
            if (this._props[prop].raw !== null || !hasOwn(optionsData, prop)) {
              set(optionsData, prop, propsData[prop]);
            }
          }
        }
        var data = this._data;
        var keys = Object.keys(data);
        var i,
            key;
        i = keys.length;
        while (i--) {
          key = keys[i];
          this._proxy(key);
        }
        observe(data, this);
      };
      Vue.prototype._setData = function(newData) {
        newData = newData || {};
        var oldData = this._data;
        this._data = newData;
        var keys,
            key,
            i;
        keys = Object.keys(oldData);
        i = keys.length;
        while (i--) {
          key = keys[i];
          if (!(key in newData)) {
            this._unproxy(key);
          }
        }
        keys = Object.keys(newData);
        i = keys.length;
        while (i--) {
          key = keys[i];
          if (!hasOwn(this, key)) {
            this._proxy(key);
          }
        }
        oldData.__ob__.removeVm(this);
        observe(newData, this);
        this._digest();
      };
      Vue.prototype._proxy = function(key) {
        if (!isReserved(key)) {
          var self = this;
          Object.defineProperty(self, key, {
            configurable: true,
            enumerable: true,
            get: function proxyGetter() {
              return self._data[key];
            },
            set: function proxySetter(val) {
              self._data[key] = val;
            }
          });
        }
      };
      Vue.prototype._unproxy = function(key) {
        if (!isReserved(key)) {
          delete this[key];
        }
      };
      Vue.prototype._digest = function() {
        for (var i = 0,
            l = this._watchers.length; i < l; i++) {
          this._watchers[i].update(true);
        }
      };
      function noop() {}
      Vue.prototype._initComputed = function() {
        var computed = this.$options.computed;
        if (computed) {
          for (var key in computed) {
            var userDef = computed[key];
            var def = {
              enumerable: true,
              configurable: true
            };
            if (typeof userDef === 'function') {
              def.get = makeComputedGetter(userDef, this);
              def.set = noop;
            } else {
              def.get = userDef.get ? userDef.cache !== false ? makeComputedGetter(userDef.get, this) : bind$1(userDef.get, this) : noop;
              def.set = userDef.set ? bind$1(userDef.set, this) : noop;
            }
            Object.defineProperty(this, key, def);
          }
        }
      };
      function makeComputedGetter(getter, owner) {
        var watcher = new Watcher(owner, getter, null, {lazy: true});
        return function computedGetter() {
          if (watcher.dirty) {
            watcher.evaluate();
          }
          if (Dep.target) {
            watcher.depend();
          }
          return watcher.value;
        };
      }
      Vue.prototype._initMethods = function() {
        var methods = this.$options.methods;
        if (methods) {
          for (var key in methods) {
            this[key] = bind$1(methods[key], this);
          }
        }
      };
      Vue.prototype._initMeta = function() {
        var metas = this.$options._meta;
        if (metas) {
          for (var key in metas) {
            defineReactive(this, key, metas[key]);
          }
        }
      };
    }
    var eventRE = /^v-on:|^@/;
    function eventsMixin(Vue) {
      Vue.prototype._initEvents = function() {
        var options = this.$options;
        if (options._asComponent) {
          registerComponentEvents(this, options.el);
        }
        registerCallbacks(this, '$on', options.events);
        registerCallbacks(this, '$watch', options.watch);
      };
      function registerComponentEvents(vm, el) {
        var attrs = el.attributes;
        var name,
            handler;
        for (var i = 0,
            l = attrs.length; i < l; i++) {
          name = attrs[i].name;
          if (eventRE.test(name)) {
            name = name.replace(eventRE, '');
            handler = (vm._scope || vm._context).$eval(attrs[i].value, true);
            vm.$on(name.replace(eventRE), handler);
          }
        }
      }
      function registerCallbacks(vm, action, hash) {
        if (!hash)
          return;
        var handlers,
            key,
            i,
            j;
        for (key in hash) {
          handlers = hash[key];
          if (isArray(handlers)) {
            for (i = 0, j = handlers.length; i < j; i++) {
              register(vm, action, key, handlers[i]);
            }
          } else {
            register(vm, action, key, handlers);
          }
        }
      }
      function register(vm, action, key, handler, options) {
        var type = typeof handler;
        if (type === 'function') {
          vm[action](key, handler, options);
        } else if (type === 'string') {
          var methods = vm.$options.methods;
          var method = methods && methods[handler];
          if (method) {
            vm[action](key, method, options);
          } else {
            process.env.NODE_ENV !== 'production' && warn('Unknown method: "' + handler + '" when ' + 'registering callback for ' + action + ': "' + key + '".');
          }
        } else if (handler && type === 'object') {
          register(vm, action, key, handler.handler, handler);
        }
      }
      Vue.prototype._initDOMHooks = function() {
        this.$on('hook:attached', onAttached);
        this.$on('hook:detached', onDetached);
      };
      function onAttached() {
        if (!this._isAttached) {
          this._isAttached = true;
          this.$children.forEach(callAttach);
        }
      }
      function callAttach(child) {
        if (!child._isAttached && inDoc(child.$el)) {
          child._callHook('attached');
        }
      }
      function onDetached() {
        if (this._isAttached) {
          this._isAttached = false;
          this.$children.forEach(callDetach);
        }
      }
      function callDetach(child) {
        if (child._isAttached && !inDoc(child.$el)) {
          child._callHook('detached');
        }
      }
      Vue.prototype._callHook = function(hook) {
        this.$emit('pre-hook:' + hook);
        var handlers = this.$options[hook];
        if (handlers) {
          for (var i = 0,
              j = handlers.length; i < j; i++) {
            handlers[i].call(this);
          }
        }
        this.$emit('hook:' + hook);
      };
    }
    function noop() {}
    function Directive(descriptor, vm, el, host, scope, frag) {
      this.vm = vm;
      this.el = el;
      this.descriptor = descriptor;
      this.name = descriptor.name;
      this.expression = descriptor.expression;
      this.arg = descriptor.arg;
      this.modifiers = descriptor.modifiers;
      this.filters = descriptor.filters;
      this.literal = this.modifiers && this.modifiers.literal;
      this._locked = false;
      this._bound = false;
      this._listeners = null;
      this._host = host;
      this._scope = scope;
      this._frag = frag;
      if (process.env.NODE_ENV !== 'production' && this.el) {
        this.el._vue_directives = this.el._vue_directives || [];
        this.el._vue_directives.push(this);
      }
    }
    Directive.prototype._bind = function() {
      var name = this.name;
      var descriptor = this.descriptor;
      if ((name !== 'cloak' || this.vm._isCompiled) && this.el && this.el.removeAttribute) {
        var attr = descriptor.attr || 'v-' + name;
        this.el.removeAttribute(attr);
      }
      var def = descriptor.def;
      if (typeof def === 'function') {
        this.update = def;
      } else {
        extend(this, def);
      }
      this._setupParams();
      if (this.bind) {
        this.bind();
      }
      this._bound = true;
      if (this.literal) {
        this.update && this.update(descriptor.raw);
      } else if ((this.expression || this.modifiers) && (this.update || this.twoWay) && !this._checkStatement()) {
        var dir = this;
        if (this.update) {
          this._update = function(val, oldVal) {
            if (!dir._locked) {
              dir.update(val, oldVal);
            }
          };
        } else {
          this._update = noop;
        }
        var preProcess = this._preProcess ? bind$1(this._preProcess, this) : null;
        var postProcess = this._postProcess ? bind$1(this._postProcess, this) : null;
        var watcher = this._watcher = new Watcher(this.vm, this.expression, this._update, {
          filters: this.filters,
          twoWay: this.twoWay,
          deep: this.deep,
          preProcess: preProcess,
          postProcess: postProcess,
          scope: this._scope
        });
        if (this.afterBind) {
          this.afterBind();
        } else if (this.update) {
          this.update(watcher.value);
        }
      }
    };
    Directive.prototype._setupParams = function() {
      if (!this.params) {
        return;
      }
      var params = this.params;
      this.params = Object.create(null);
      var i = params.length;
      var key,
          val,
          mappedKey;
      while (i--) {
        key = params[i];
        mappedKey = camelize(key);
        val = getBindAttr(this.el, key);
        if (val != null) {
          this._setupParamWatcher(mappedKey, val);
        } else {
          val = getAttr(this.el, key);
          if (val != null) {
            this.params[mappedKey] = val === '' ? true : val;
          }
        }
      }
    };
    Directive.prototype._setupParamWatcher = function(key, expression) {
      var self = this;
      var called = false;
      var unwatch = (this._scope || this.vm).$watch(expression, function(val, oldVal) {
        self.params[key] = val;
        if (called) {
          var cb = self.paramWatchers && self.paramWatchers[key];
          if (cb) {
            cb.call(self, val, oldVal);
          }
        } else {
          called = true;
        }
      }, {
        immediate: true,
        user: false
      });
      (this._paramUnwatchFns || (this._paramUnwatchFns = [])).push(unwatch);
    };
    Directive.prototype._checkStatement = function() {
      var expression = this.expression;
      if (expression && this.acceptStatement && !isSimplePath(expression)) {
        var fn = parseExpression(expression).get;
        var scope = this._scope || this.vm;
        var handler = function handler(e) {
          scope.$event = e;
          fn.call(scope, scope);
          scope.$event = null;
        };
        if (this.filters) {
          handler = scope._applyFilters(handler, null, this.filters);
        }
        this.update(handler);
        return true;
      }
    };
    Directive.prototype.set = function(value) {
      if (this.twoWay) {
        this._withLock(function() {
          this._watcher.set(value);
        });
      } else if (process.env.NODE_ENV !== 'production') {
        warn('Directive.set() can only be used inside twoWay' + 'directives.');
      }
    };
    Directive.prototype._withLock = function(fn) {
      var self = this;
      self._locked = true;
      fn.call(self);
      nextTick(function() {
        self._locked = false;
      });
    };
    Directive.prototype.on = function(event, handler) {
      on$1(this.el, event, handler);
      (this._listeners || (this._listeners = [])).push([event, handler]);
    };
    Directive.prototype._teardown = function() {
      if (this._bound) {
        this._bound = false;
        if (this.unbind) {
          this.unbind();
        }
        if (this._watcher) {
          this._watcher.teardown();
        }
        var listeners = this._listeners;
        var i;
        if (listeners) {
          i = listeners.length;
          while (i--) {
            off(this.el, listeners[i][0], listeners[i][1]);
          }
        }
        var unwatchFns = this._paramUnwatchFns;
        if (unwatchFns) {
          i = unwatchFns.length;
          while (i--) {
            unwatchFns[i]();
          }
        }
        if (process.env.NODE_ENV !== 'production' && this.el) {
          this.el._vue_directives.$remove(this);
        }
        this.vm = this.el = this._watcher = this._listeners = null;
      }
    };
    function lifecycleMixin(Vue) {
      Vue.prototype._updateRef = function(remove) {
        var ref = this.$options._ref;
        if (ref) {
          var refs = (this._scope || this._context).$refs;
          if (remove) {
            if (refs[ref] === this) {
              refs[ref] = null;
            }
          } else {
            refs[ref] = this;
          }
        }
      };
      Vue.prototype._compile = function(el) {
        var options = this.$options;
        var original = el;
        el = transclude(el, options);
        this._initElement(el);
        if (el.nodeType === 1 && getAttr(el, 'v-pre') !== null) {
          return;
        }
        var contextOptions = this._context && this._context.$options;
        var rootLinker = compileRoot(el, options, contextOptions);
        var contentLinkFn;
        var ctor = this.constructor;
        if (options._linkerCachable) {
          contentLinkFn = ctor.linker;
          if (!contentLinkFn) {
            contentLinkFn = ctor.linker = compile(el, options);
          }
        }
        var rootUnlinkFn = rootLinker(this, el, this._scope);
        var contentUnlinkFn = contentLinkFn ? contentLinkFn(this, el) : compile(el, options)(this, el);
        this._unlinkFn = function() {
          rootUnlinkFn();
          contentUnlinkFn(true);
        };
        if (options.replace) {
          replace(original, el);
        }
        this._isCompiled = true;
        this._callHook('compiled');
        return el;
      };
      Vue.prototype._initElement = function(el) {
        if (el instanceof DocumentFragment) {
          this._isFragment = true;
          this.$el = this._fragmentStart = el.firstChild;
          this._fragmentEnd = el.lastChild;
          if (this._fragmentStart.nodeType === 3) {
            this._fragmentStart.data = this._fragmentEnd.data = '';
          }
          this._fragment = el;
        } else {
          this.$el = el;
        }
        this.$el.__vue__ = this;
        this._callHook('beforeCompile');
      };
      Vue.prototype._bindDir = function(descriptor, node, host, scope, frag) {
        this._directives.push(new Directive(descriptor, this, node, host, scope, frag));
      };
      Vue.prototype._destroy = function(remove, deferCleanup) {
        if (this._isBeingDestroyed) {
          if (!deferCleanup) {
            this._cleanup();
          }
          return;
        }
        var destroyReady;
        var pendingRemoval;
        var self = this;
        var cleanupIfPossible = function cleanupIfPossible() {
          if (destroyReady && !pendingRemoval && !deferCleanup) {
            self._cleanup();
          }
        };
        if (remove && this.$el) {
          pendingRemoval = true;
          this.$remove(function() {
            pendingRemoval = false;
            cleanupIfPossible();
          });
        }
        this._callHook('beforeDestroy');
        this._isBeingDestroyed = true;
        var i;
        var parent = this.$parent;
        if (parent && !parent._isBeingDestroyed) {
          parent.$children.$remove(this);
          this._updateRef(true);
        }
        i = this.$children.length;
        while (i--) {
          this.$children[i].$destroy();
        }
        if (this._propsUnlinkFn) {
          this._propsUnlinkFn();
        }
        if (this._unlinkFn) {
          this._unlinkFn();
        }
        i = this._watchers.length;
        while (i--) {
          this._watchers[i].teardown();
        }
        if (this.$el) {
          this.$el.__vue__ = null;
        }
        destroyReady = true;
        cleanupIfPossible();
      };
      Vue.prototype._cleanup = function() {
        if (this._isDestroyed) {
          return;
        }
        if (this._frag) {
          this._frag.children.$remove(this);
        }
        if (this._data.__ob__) {
          this._data.__ob__.removeVm(this);
        }
        this.$el = this.$parent = this.$root = this.$children = this._watchers = this._context = this._scope = this._directives = null;
        this._isDestroyed = true;
        this._callHook('destroyed');
        this.$off();
      };
    }
    function miscMixin(Vue) {
      Vue.prototype._applyFilters = function(value, oldValue, filters, write) {
        var filter,
            fn,
            args,
            arg,
            offset,
            i,
            l,
            j,
            k;
        for (i = 0, l = filters.length; i < l; i++) {
          filter = filters[i];
          fn = resolveAsset(this.$options, 'filters', filter.name);
          if (process.env.NODE_ENV !== 'production') {
            assertAsset(fn, 'filter', filter.name);
          }
          if (!fn)
            continue;
          fn = write ? fn.write : fn.read || fn;
          if (typeof fn !== 'function')
            continue;
          args = write ? [value, oldValue] : [value];
          offset = write ? 2 : 1;
          if (filter.args) {
            for (j = 0, k = filter.args.length; j < k; j++) {
              arg = filter.args[j];
              args[j + offset] = arg.dynamic ? this.$get(arg.value) : arg.value;
            }
          }
          value = fn.apply(this, args);
        }
        return value;
      };
      Vue.prototype._resolveComponent = function(id, cb) {
        var factory = resolveAsset(this.$options, 'components', id);
        if (process.env.NODE_ENV !== 'production') {
          assertAsset(factory, 'component', id);
        }
        if (!factory) {
          return;
        }
        if (!factory.options) {
          if (factory.resolved) {
            cb(factory.resolved);
          } else if (factory.requested) {
            factory.pendingCallbacks.push(cb);
          } else {
            factory.requested = true;
            var cbs = factory.pendingCallbacks = [cb];
            factory(function resolve(res) {
              if (isPlainObject(res)) {
                res = Vue.extend(res);
              }
              factory.resolved = res;
              for (var i = 0,
                  l = cbs.length; i < l; i++) {
                cbs[i](res);
              }
            }, function reject(reason) {
              process.env.NODE_ENV !== 'production' && warn('Failed to resolve async component: ' + id + '. ' + (reason ? '\nReason: ' + reason : ''));
            });
          }
        } else {
          cb(factory);
        }
      };
    }
    function globalAPI(Vue) {
      Vue.util = util;
      Vue.config = config;
      Vue.set = set;
      Vue['delete'] = del;
      Vue.nextTick = nextTick;
      Vue.compiler = compiler;
      Vue.FragmentFactory = FragmentFactory;
      Vue.internalDirectives = internalDirectives;
      Vue.parsers = {
        path: path,
        text: text$1,
        template: template,
        directive: directive,
        expression: expression
      };
      Vue.cid = 0;
      var cid = 1;
      Vue.extend = function(extendOptions) {
        extendOptions = extendOptions || {};
        var Super = this;
        var isFirstExtend = Super.cid === 0;
        if (isFirstExtend && extendOptions._Ctor) {
          return extendOptions._Ctor;
        }
        var name = extendOptions.name || Super.options.name;
        if (process.env.NODE_ENV !== 'production') {
          if (!/^[a-zA-Z][\w-]+$/.test(name)) {
            warn('Invalid component name: ' + name);
            name = null;
          }
        }
        var Sub = createClass(name || 'VueComponent');
        Sub.prototype = Object.create(Super.prototype);
        Sub.prototype.constructor = Sub;
        Sub.cid = cid++;
        Sub.options = mergeOptions(Super.options, extendOptions);
        Sub['super'] = Super;
        Sub.extend = Super.extend;
        config._assetTypes.forEach(function(type) {
          Sub[type] = Super[type];
        });
        if (name) {
          Sub.options.components[name] = Sub;
        }
        if (isFirstExtend) {
          extendOptions._Ctor = Sub;
        }
        return Sub;
      };
      function createClass(name) {
        return new Function('return function ' + classify(name) + ' (options) { this._init(options) }')();
      }
      Vue.use = function(plugin) {
        if (plugin.installed) {
          return;
        }
        var args = toArray(arguments, 1);
        args.unshift(this);
        if (typeof plugin.install === 'function') {
          plugin.install.apply(plugin, args);
        } else {
          plugin.apply(null, args);
        }
        plugin.installed = true;
        return this;
      };
      Vue.mixin = function(mixin) {
        Vue.options = mergeOptions(Vue.options, mixin);
      };
      config._assetTypes.forEach(function(type) {
        Vue[type] = function(id, definition) {
          if (!definition) {
            return this.options[type + 's'][id];
          } else {
            if (process.env.NODE_ENV !== 'production') {
              if (type === 'component' && (commonTagRE.test(id) || reservedTagRE.test(id))) {
                warn('Do not use built-in or reserved HTML elements as component ' + 'id: ' + id);
              }
            }
            if (type === 'component' && isPlainObject(definition)) {
              definition.name = id;
              definition = Vue.extend(definition);
            }
            this.options[type + 's'][id] = definition;
            return definition;
          }
        };
      });
    }
    var filterRE = /[^|]\|[^|]/;
    function dataAPI(Vue) {
      Vue.prototype.$get = function(exp, asStatement) {
        var res = parseExpression(exp);
        if (res) {
          if (asStatement && !isSimplePath(exp)) {
            var self = this;
            return function statementHandler() {
              self.$arguments = toArray(arguments);
              res.get.call(self, self);
              self.$arguments = null;
            };
          } else {
            try {
              return res.get.call(this, this);
            } catch (e) {}
          }
        }
      };
      Vue.prototype.$set = function(exp, val) {
        var res = parseExpression(exp, true);
        if (res && res.set) {
          res.set.call(this, this, val);
        }
      };
      Vue.prototype.$delete = function(key) {
        del(this._data, key);
      };
      Vue.prototype.$watch = function(expOrFn, cb, options) {
        var vm = this;
        var parsed;
        if (typeof expOrFn === 'string') {
          parsed = parseDirective(expOrFn);
          expOrFn = parsed.expression;
        }
        var watcher = new Watcher(vm, expOrFn, cb, {
          deep: options && options.deep,
          sync: options && options.sync,
          filters: parsed && parsed.filters,
          user: !options || options.user !== false
        });
        if (options && options.immediate) {
          cb.call(vm, watcher.value);
        }
        return function unwatchFn() {
          watcher.teardown();
        };
      };
      Vue.prototype.$eval = function(text, asStatement) {
        if (filterRE.test(text)) {
          var dir = parseDirective(text);
          var val = this.$get(dir.expression, asStatement);
          return dir.filters ? this._applyFilters(val, null, dir.filters) : val;
        } else {
          return this.$get(text, asStatement);
        }
      };
      Vue.prototype.$interpolate = function(text) {
        var tokens = parseText(text);
        var vm = this;
        if (tokens) {
          if (tokens.length === 1) {
            return vm.$eval(tokens[0].value) + '';
          } else {
            return tokens.map(function(token) {
              return token.tag ? vm.$eval(token.value) : token.value;
            }).join('');
          }
        } else {
          return text;
        }
      };
      Vue.prototype.$log = function(path) {
        var data = path ? getPath(this._data, path) : this._data;
        if (data) {
          data = clean(data);
        }
        if (!path) {
          for (var key in this.$options.computed) {
            data[key] = clean(this[key]);
          }
        }
        console.log(data);
      };
      function clean(obj) {
        return JSON.parse(JSON.stringify(obj));
      }
    }
    function domAPI(Vue) {
      Vue.prototype.$nextTick = function(fn) {
        nextTick(fn, this);
      };
      Vue.prototype.$appendTo = function(target, cb, withTransition) {
        return insert(this, target, cb, withTransition, append, appendWithTransition);
      };
      Vue.prototype.$prependTo = function(target, cb, withTransition) {
        target = query(target);
        if (target.hasChildNodes()) {
          this.$before(target.firstChild, cb, withTransition);
        } else {
          this.$appendTo(target, cb, withTransition);
        }
        return this;
      };
      Vue.prototype.$before = function(target, cb, withTransition) {
        return insert(this, target, cb, withTransition, beforeWithCb, beforeWithTransition);
      };
      Vue.prototype.$after = function(target, cb, withTransition) {
        target = query(target);
        if (target.nextSibling) {
          this.$before(target.nextSibling, cb, withTransition);
        } else {
          this.$appendTo(target.parentNode, cb, withTransition);
        }
        return this;
      };
      Vue.prototype.$remove = function(cb, withTransition) {
        if (!this.$el.parentNode) {
          return cb && cb();
        }
        var inDocument = this._isAttached && inDoc(this.$el);
        if (!inDocument)
          withTransition = false;
        var self = this;
        var realCb = function realCb() {
          if (inDocument)
            self._callHook('detached');
          if (cb)
            cb();
        };
        if (this._isFragment) {
          removeNodeRange(this._fragmentStart, this._fragmentEnd, this, this._fragment, realCb);
        } else {
          var op = withTransition === false ? removeWithCb : removeWithTransition;
          op(this.$el, this, realCb);
        }
        return this;
      };
      function insert(vm, target, cb, withTransition, op1, op2) {
        target = query(target);
        var targetIsDetached = !inDoc(target);
        var op = withTransition === false || targetIsDetached ? op1 : op2;
        var shouldCallHook = !targetIsDetached && !vm._isAttached && !inDoc(vm.$el);
        if (vm._isFragment) {
          mapNodeRange(vm._fragmentStart, vm._fragmentEnd, function(node) {
            op(node, target, vm);
          });
          cb && cb();
        } else {
          op(vm.$el, target, vm, cb);
        }
        if (shouldCallHook) {
          vm._callHook('attached');
        }
        return vm;
      }
      function query(el) {
        return typeof el === 'string' ? document.querySelector(el) : el;
      }
      function append(el, target, vm, cb) {
        target.appendChild(el);
        if (cb)
          cb();
      }
      function beforeWithCb(el, target, vm, cb) {
        before(el, target);
        if (cb)
          cb();
      }
      function removeWithCb(el, vm, cb) {
        remove(el);
        if (cb)
          cb();
      }
    }
    function eventsAPI(Vue) {
      Vue.prototype.$on = function(event, fn) {
        (this._events[event] || (this._events[event] = [])).push(fn);
        modifyListenerCount(this, event, 1);
        return this;
      };
      Vue.prototype.$once = function(event, fn) {
        var self = this;
        function on() {
          self.$off(event, on);
          fn.apply(this, arguments);
        }
        on.fn = fn;
        this.$on(event, on);
        return this;
      };
      Vue.prototype.$off = function(event, fn) {
        var cbs;
        if (!arguments.length) {
          if (this.$parent) {
            for (event in this._events) {
              cbs = this._events[event];
              if (cbs) {
                modifyListenerCount(this, event, -cbs.length);
              }
            }
          }
          this._events = {};
          return this;
        }
        cbs = this._events[event];
        if (!cbs) {
          return this;
        }
        if (arguments.length === 1) {
          modifyListenerCount(this, event, -cbs.length);
          this._events[event] = null;
          return this;
        }
        var cb;
        var i = cbs.length;
        while (i--) {
          cb = cbs[i];
          if (cb === fn || cb.fn === fn) {
            modifyListenerCount(this, event, -1);
            cbs.splice(i, 1);
            break;
          }
        }
        return this;
      };
      Vue.prototype.$emit = function(event) {
        var cbs = this._events[event];
        var shouldPropagate = !cbs;
        if (cbs) {
          cbs = cbs.length > 1 ? toArray(cbs) : cbs;
          var args = toArray(arguments, 1);
          for (var i = 0,
              l = cbs.length; i < l; i++) {
            var res = cbs[i].apply(this, args);
            if (res === true) {
              shouldPropagate = true;
            }
          }
        }
        return shouldPropagate;
      };
      Vue.prototype.$broadcast = function(event) {
        if (!this._eventsCount[event])
          return;
        var children = this.$children;
        for (var i = 0,
            l = children.length; i < l; i++) {
          var child = children[i];
          var shouldPropagate = child.$emit.apply(child, arguments);
          if (shouldPropagate) {
            child.$broadcast.apply(child, arguments);
          }
        }
        return this;
      };
      Vue.prototype.$dispatch = function() {
        this.$emit.apply(this, arguments);
        var parent = this.$parent;
        while (parent) {
          var shouldPropagate = parent.$emit.apply(parent, arguments);
          parent = shouldPropagate ? parent.$parent : null;
        }
        return this;
      };
      var hookRE = /^hook:/;
      function modifyListenerCount(vm, event, count) {
        var parent = vm.$parent;
        if (!parent || !count || hookRE.test(event))
          return;
        while (parent) {
          parent._eventsCount[event] = (parent._eventsCount[event] || 0) + count;
          parent = parent.$parent;
        }
      }
    }
    function lifecycleAPI(Vue) {
      Vue.prototype.$mount = function(el) {
        if (this._isCompiled) {
          process.env.NODE_ENV !== 'production' && warn('$mount() should be called only once.');
          return;
        }
        el = query(el);
        if (!el) {
          el = document.createElement('div');
        }
        this._compile(el);
        this._initDOMHooks();
        if (inDoc(this.$el)) {
          this._callHook('attached');
          ready.call(this);
        } else {
          this.$once('hook:attached', ready);
        }
        return this;
      };
      function ready() {
        this._isAttached = true;
        this._isReady = true;
        this._callHook('ready');
      }
      Vue.prototype.$destroy = function(remove, deferCleanup) {
        this._destroy(remove, deferCleanup);
      };
      Vue.prototype.$compile = function(el, host, scope, frag) {
        return compile(el, this.$options, true)(this, el, host, scope, frag);
      };
    }
    function Vue(options) {
      this._init(options);
    }
    initMixin(Vue);
    stateMixin(Vue);
    eventsMixin(Vue);
    lifecycleMixin(Vue);
    miscMixin(Vue);
    globalAPI(Vue);
    dataAPI(Vue);
    domAPI(Vue);
    eventsAPI(Vue);
    lifecycleAPI(Vue);
    var convertArray = vFor._postProcess;
    function limitBy(arr, n, offset) {
      offset = offset ? parseInt(offset, 10) : 0;
      return typeof n === 'number' ? arr.slice(offset, offset + n) : arr;
    }
    function filterBy(arr, search, delimiter) {
      arr = convertArray(arr);
      if (search == null) {
        return arr;
      }
      if (typeof search === 'function') {
        return arr.filter(search);
      }
      search = ('' + search).toLowerCase();
      var n = delimiter === 'in' ? 3 : 2;
      var keys = toArray(arguments, n).reduce(function(prev, cur) {
        return prev.concat(cur);
      }, []);
      var res = [];
      var item,
          key,
          val,
          j;
      for (var i = 0,
          l = arr.length; i < l; i++) {
        item = arr[i];
        val = item && item.$value || item;
        j = keys.length;
        if (j) {
          while (j--) {
            key = keys[j];
            if (key === '$key' && contains(item.$key, search) || contains(getPath(val, key), search)) {
              res.push(item);
              break;
            }
          }
        } else if (contains(item, search)) {
          res.push(item);
        }
      }
      return res;
    }
    function orderBy(arr, sortKey, reverse) {
      arr = convertArray(arr);
      if (!sortKey) {
        return arr;
      }
      var order = reverse && reverse < 0 ? -1 : 1;
      return arr.slice().sort(function(a, b) {
        if (sortKey !== '$key') {
          if (isObject(a) && '$value' in a)
            a = a.$value;
          if (isObject(b) && '$value' in b)
            b = b.$value;
        }
        a = isObject(a) ? getPath(a, sortKey) : a;
        b = isObject(b) ? getPath(b, sortKey) : b;
        return a === b ? 0 : a > b ? order : -order;
      });
    }
    function contains(val, search) {
      var i;
      if (isPlainObject(val)) {
        var keys = Object.keys(val);
        i = keys.length;
        while (i--) {
          if (contains(val[keys[i]], search)) {
            return true;
          }
        }
      } else if (isArray(val)) {
        i = val.length;
        while (i--) {
          if (contains(val[i], search)) {
            return true;
          }
        }
      } else if (val != null) {
        return val.toString().toLowerCase().indexOf(search) > -1;
      }
    }
    var digitsRE = /(\d{3})(?=\d)/g;
    var filters = {
      orderBy: orderBy,
      filterBy: filterBy,
      limitBy: limitBy,
      json: {
        read: function read(value, indent) {
          return typeof value === 'string' ? value : JSON.stringify(value, null, Number(indent) || 2);
        },
        write: function write(value) {
          try {
            return JSON.parse(value);
          } catch (e) {
            return value;
          }
        }
      },
      capitalize: function capitalize(value) {
        if (!value && value !== 0)
          return '';
        value = value.toString();
        return value.charAt(0).toUpperCase() + value.slice(1);
      },
      uppercase: function uppercase(value) {
        return value || value === 0 ? value.toString().toUpperCase() : '';
      },
      lowercase: function lowercase(value) {
        return value || value === 0 ? value.toString().toLowerCase() : '';
      },
      currency: function currency(value, _currency) {
        value = parseFloat(value);
        if (!isFinite(value) || !value && value !== 0)
          return '';
        _currency = _currency != null ? _currency : '$';
        var stringified = Math.abs(value).toFixed(2);
        var _int = stringified.slice(0, -3);
        var i = _int.length % 3;
        var head = i > 0 ? _int.slice(0, i) + (_int.length > 3 ? ',' : '') : '';
        var _float = stringified.slice(-3);
        var sign = value < 0 ? '-' : '';
        return _currency + sign + head + _int.slice(i).replace(digitsRE, '$1,') + _float;
      },
      pluralize: function pluralize(value) {
        var args = toArray(arguments, 1);
        return args.length > 1 ? args[value % 10 - 1] || args[args.length - 1] : args[0] + (value === 1 ? '' : 's');
      },
      debounce: function debounce(handler, delay) {
        if (!handler)
          return;
        if (!delay) {
          delay = 300;
        }
        return _debounce(handler, delay);
      }
    };
    var partial = {
      priority: PARTIAL,
      params: ['name'],
      paramWatchers: {name: function name(value) {
          vIf.remove.call(this);
          if (value) {
            this.insert(value);
          }
        }},
      bind: function bind() {
        this.anchor = createAnchor('v-partial');
        replace(this.el, this.anchor);
        this.insert(this.params.name);
      },
      insert: function insert(id) {
        var partial = resolveAsset(this.vm.$options, 'partials', id);
        if (process.env.NODE_ENV !== 'production') {
          assertAsset(partial, 'partial', id);
        }
        if (partial) {
          this.factory = new FragmentFactory(this.vm, partial);
          vIf.insert.call(this);
        }
      },
      unbind: function unbind() {
        if (this.frag) {
          this.frag.destroy();
        }
      }
    };
    var slot = {
      priority: SLOT,
      bind: function bind() {
        var host = this.vm;
        var raw = host.$options._content;
        if (!raw) {
          this.fallback();
          return;
        }
        var context = host._context;
        var slotName = this.params && this.params.name;
        if (!slotName) {
          this.tryCompile(extractFragment(raw.childNodes, raw, true), context, host);
        } else {
          var selector = '[slot="' + slotName + '"]';
          var nodes = raw.querySelectorAll(selector);
          if (nodes.length) {
            this.tryCompile(extractFragment(nodes, raw), context, host);
          } else {
            this.fallback();
          }
        }
      },
      tryCompile: function tryCompile(content, context, host) {
        if (content.hasChildNodes()) {
          this.compile(content, context, host);
        } else {
          this.fallback();
        }
      },
      compile: function compile(content, context, host) {
        if (content && context) {
          var scope = host ? host._scope : this._scope;
          this.unlink = context.$compile(content, host, scope, this._frag);
        }
        if (content) {
          replace(this.el, content);
        } else {
          remove(this.el);
        }
      },
      fallback: function fallback() {
        this.compile(extractContent(this.el, true), this.vm);
      },
      unbind: function unbind() {
        if (this.unlink) {
          this.unlink();
        }
      }
    };
    var namedSlot = extend(extend({}, slot), {
      priority: slot.priority + 1,
      params: ['name']
    });
    function extractFragment(nodes, parent, main) {
      var frag = document.createDocumentFragment();
      for (var i = 0,
          l = nodes.length; i < l; i++) {
        var node = nodes[i];
        if (main && !node.__v_selected) {
          append(node);
        } else if (!main && node.parentNode === parent) {
          node.__v_selected = true;
          append(node);
        }
      }
      return frag;
      function append(node) {
        if (isTemplate(node) && !node.hasAttribute('v-if') && !node.hasAttribute('v-for')) {
          node = parseTemplate(node);
        }
        node = cloneNode(node);
        frag.appendChild(node);
      }
    }
    var elementDirectives = {
      slot: slot,
      _namedSlot: namedSlot,
      partial: partial
    };
    Vue.version = '1.0.13';
    Vue.options = {
      directives: publicDirectives,
      elementDirectives: elementDirectives,
      filters: filters,
      transitions: {},
      components: {},
      partials: {},
      replace: true
    };
    if (process.env.NODE_ENV !== 'production' && inBrowser) {
      if (window.__VUE_DEVTOOLS_GLOBAL_HOOK__) {
        window.__VUE_DEVTOOLS_GLOBAL_HOOK__.emit('init', Vue);
      } else if (/Chrome\/\d+/.test(navigator.userAgent)) {
        console.log('Download the Vue Devtools for a better development experience:\n' + 'https://github.com/vuejs/vue-devtools');
      }
    }
    module.exports = Vue;
  })(req('7'));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("c", ["b"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = req('b');
  global.define = __define;
  return module.exports;
});

$__System.register('d', [], function (_export) {
  'use strict';

  var debug, ws_url;
  return {
    setters: [],
    execute: function () {
      debug = false;

      _export('debug', debug);

      ws_url = 'ws://petermac.local:8080/websocket';

      _export('ws_url', ws_url);
    }
  };
});
$__System.register('1', ['2', '3', 'a', 'c', 'd'], function (_export) {
	'use strict';

	var tmpl, WS, Vue, debug, ws_url, appl;
	return {
		setters: [function (_) {}, function (_2) {
			tmpl = _2['default'];
		}, function (_a) {
			WS = _a['default'];
		}, function (_c) {
			Vue = _c['default'];
		}, function (_d) {
			debug = _d.debug;
			ws_url = _d.ws_url;
		}],
		execute: function () {

			Vue.config.debug = debug;

			appl = window.appl = new Vue({
				el: '.main',
				template: tmpl,
				data: function data() {
					return {
						loading: true,
						connected: false,
						error: null,
						message: '',
						games: [],
						game: null,
						username: null,
						new_game_name: null,
						say_what: null
					};
				},
				methods: {
					connect: function connect() {
						if (this.connected === false) {
							this.$ws = new WS(this, ws_url);
						}
					},
					create_game: function create_game() {
						var _this = this;

						if (this.new_game_name) {
							this.$ws.rpc("create_game", { name: this.new_game_name }).then(function (result) {
								_this.new_game_name = null;
							});
						}
					},
					enter_game: function enter_game(name) {
						var _this2 = this;

						return this.$ws.rpc("enter_game", { name: name, username: this.username }).then(function (result) {
							_this2.game = result;
						});
					},
					leave_game: function leave_game() {
						var _this3 = this;

						this.$ws.rpc("leave_game", {}).then(function (result) {
							_this3.game = null;
						});
					},
					say: function say() {
						var _this4 = this;

						this.$ws.rpc("say", { message: this.say_what }).then(function (result) {
							_this4.say_what = null;
						});
					},
					load_state: function load_state() {
						if (window.localStorage) {
							var state = localStorage.getItem("state");
							if (state) {
								state = JSON.parse(state);
							}
							this.username = state ? state.username : null;
							if (state && state.game_name) {
								return this.enter_game(state.game_name);
							}
						} else {
							this.error = "No local storeage!";
						}
					},
					save_state: function save_state() {
						if (window.localStorage) {
							localStorage.setItem("state", JSON.stringify({
								username: this.username,
								game_name: this.game ? this.game.name : null
							}));
						} else {
							this.error = "No local storeage!";
						}
					},
					rotation: function rotation(index) {
						var deg = 360 / this.game.users.length * index;
						return "rotate(" + deg + "deg)";
					}
				},
				events: {
					created_game: function created_game(message) {
						this.games.push(message);
					},
					entered_game: function entered_game(message) {
						this.game.users.push(message);
						this.game.transcript.push({ signal: 'entered_game', message: message });
					},
					left_game: function left_game(message) {
						var index = this.game.users.indexOf(message);
						if (index != -1) {
							this.game.users.splice(index, 1);
						}
						this.game.transcript.push({ signal: 'left_game', message: message });
					},
					said: function said(message) {
						this.game.transcript.push({ signal: 'said', message: message });
					}
				},
				created: function created() {
					this.connect();
				},
				watch: {
					username: function username() {
						this.save_state();
					},
					game: function game() {
						this.save_state();
					}
				},
				ready: function ready() {
					var _this5 = this;

					this.loading = false;
					this.$ws.rpc("echo", { message: "foobar" }).then(function (result) {
						_this5.message = result;
					});
					this.$ws.rpc("get_games", {}).then(function (result) {
						_this5.games = result;
						_this5.load_state();
					});
				}
			});
		}
	};
});
$__System.register('appl/main.css!github:systemjs/plugin-css@0.1.20', [], false, function() {});
(function(c){if (typeof document == 'undefined') return; var d=document,a='appendChild',i='styleSheet',s=d.createElement('style');s.type='text/css';d.getElementsByTagName('head')[0][a](s);s[i]?s[i].cssText=c:s[a](d.createTextNode(c));})
(".error{color:red;font-size:1.1em;padding:1em;border:1px solid red;border-radius:.4em;margin:1em}.off-line{color:purple;float:right}.on-line{color:green;float:right}");
})
(function(factory) {
  factory();
});
//# sourceMappingURL=appl.js.map