"""Private dependency injection for native code in the desktop process only.

Native modules, functions and classes are never assigned to or modified. A scope
owns callable copies with the SAME code objects, private globals, and a private
builtins mapping. Import routing belongs to those copies, not the interpreter.
This allows frozen native drivers to accept launch/session factories without
copying their phase logic or relaxing their validation/ownership contracts.
"""
from __future__ import annotations

import builtins
import importlib
import types


class _View:
    def __init__(self, scope, module):
        object.__setattr__(self, 'scope', scope)
        object.__setattr__(self, 'original', module)

    def __setattr__(self, name, value):
        if name in {'scope', 'original'}:
            object.__setattr__(self, name, value)
            return
        module = self.original.__name__
        if module in self.scope.modules:
            self.scope.namespace(module)[name] = value
        else:
            self.scope.overrides.setdefault(module, {})[name] = value

    def __getattr__(self, name):
        overrides = self.scope.overrides.get(self.original.__name__, {})
        if name in overrides:
            return overrides[name]
        child = self.original.__name__ + '.' + name
        if self.scope.selected(child):
            return self.scope.module(child)
        if '__getattr__' in overrides:
            return overrides['__getattr__'](name)
        value = getattr(self.original, name)
        if isinstance(value, types.ModuleType):
            return self.scope.module(value.__name__) if self.scope.selected(value.__name__) else value
        if self.original.__name__ in self.scope.modules:
            return self.scope.namespace(self.original.__name__).get(name, value)
        return value


class NativeScope:
    def __init__(self, overrides=None, *, modules=(), classes=()):
        self.overrides = dict(overrides or {})
        self.modules = set(modules)
        self.classes = set(classes)
        self.views, self.namespaces, self.functions = {}, {}, {}

    def selected(self, name):
        return name in self.modules or name in self.overrides or any(
            path.startswith(name + '.') for path in self.modules | set(self.overrides))

    def module(self, name):
        if name not in self.views:
            try:
                original = importlib.import_module(name)
            except ModuleNotFoundError:
                if name not in self.overrides:
                    raise
                original = types.ModuleType(name)
            self.views[name] = _View(self, original)
        return self.views[name]

    def _import(self, name, globals=None, locals=None, fromlist=(), level=0):
        absolute = importlib.util.resolve_name('.' * level + name, globals['__package__']) if level else name
        if fromlist and absolute in {'agent.auxiliary_client', 'agent.context_compressor'} and absolute in self.overrides:
            return self.module(absolute)
        original = builtins.__import__(name, globals, locals, fromlist, level)
        selected = absolute if fromlist else absolute.split('.')[0]
        return self.module(selected) if self.selected(selected) else original

    def clone(self, function, namespace):
        if function in self.functions:
            return self.functions[function]
        defining = function.__globals__.get('__name__')
        if defining != namespace.get('__name__'):
            # wraps()/asynccontextmanager metadata names the wrapped module,
            # but the wrapper's bytecode still needs its DEFINING globals.
            if defining in self.modules:
                namespace = self.namespace(defining)
            else:
                namespace = dict(function.__globals__)
                namespace['__builtins__'] = {**vars(builtins), '__import__': self._import}
        closure = function.__closure__
        if closure:
            cells = []
            for cell in closure:
                value = cell.cell_contents
                if isinstance(value, types.FunctionType) and (
                        value.__module__ in self.modules or value.__globals__.get('__name__') in self.modules):
                    target = value.__globals__.get('__name__')
                    target = target if target in self.modules else value.__module__
                    cell = types.CellType(self.clone(value, self.namespace(target)))
                cells.append(cell)
            closure = tuple(cells)
        copied = types.FunctionType(function.__code__, namespace, function.__name__,
                                    function.__defaults__, closure)
        self.functions[function] = copied
        copied.__kwdefaults__ = function.__kwdefaults__
        copied.__annotations__ = dict(function.__annotations__)
        copied.__dict__.update(function.__dict__)
        copied.__qualname__ = function.__qualname__
        copied.__module__ = function.__module__
        return copied

    def namespace(self, name):
        if name in self.namespaces:
            return self.namespaces[name]
        original = importlib.import_module(name)
        namespace = dict(vars(original))
        self.namespaces[name] = namespace
        namespace['__builtins__'] = {**vars(builtins), '__import__': self._import}
        imported = []
        for module_name, replacements in self.overrides.items():
            try:
                source = importlib.import_module(module_name)
            except ModuleNotFoundError:
                continue
            imported.extend((getattr(source, symbol, None), replacement)
                            for symbol, replacement in replacements.items())
        for key, value in list(namespace.items()):
            matched = next((replacement for original_value, replacement in imported
                            if original_value is value and original_value is not None), None)
            if matched is not None:
                namespace[key] = matched
            elif isinstance(value, types.ModuleType) and self.selected(value.__name__):
                namespace[key] = self.module(value.__name__)
            elif isinstance(value, types.FunctionType) and value.__module__ == name:
                namespace[key] = self.clone(value, namespace)
            elif isinstance(value, types.FunctionType) and value.__module__ in self.modules:
                namespace[key] = self.clone(value, self.namespace(value.__module__))
            elif isinstance(value, type) and (name, key) in self.classes:
                methods = {}
                for method_name, method in vars(value).items():
                    if isinstance(method, types.FunctionType):
                        methods[method_name] = self.clone(method, namespace)
                    elif isinstance(method, staticmethod):
                        methods[method_name] = staticmethod(self.clone(method.__func__, namespace))
                    elif isinstance(method, classmethod):
                        methods[method_name] = classmethod(self.clone(method.__func__, namespace))
                    elif isinstance(method, property):
                        methods[method_name] = property(*(self.clone(accessor, namespace) if accessor else None
                            for accessor in (method.fget, method.fset, method.fdel)), doc=method.__doc__)
                injected_bases = tuple(getattr(self.module(base.__module__), base.__name__)
                    for base in value.__bases__ if (base.__module__, base.__name__) in self.classes)
                namespace[key] = type('Desktop' + key, (value, *injected_bases), methods)
            elif isinstance(value, type) and (value.__module__, value.__name__) in self.classes:
                namespace[key] = getattr(self.module(value.__module__), value.__name__)
        namespace.update(self.overrides.get(name, {}))
        return namespace


