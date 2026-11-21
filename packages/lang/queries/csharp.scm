; Symbols for C# (M16). Each pattern captures the defining node as @symbol.<kind> and its name
; as @name. Namespaces qualify nothing (a file is read on its own); properties are members like
; methods, so `user.Email` links to a changed property; fields belong to their class. An
; overloaded method or constructor has its parameter types in its qualified name
; (src/symbols.ts).

(class_declaration name: (identifier) @name) @symbol.class
(struct_declaration name: (identifier) @name) @symbol.class
(record_declaration name: (identifier) @name) @symbol.class
(interface_declaration name: (identifier) @name) @symbol.interface
(enum_declaration name: (identifier) @name) @symbol.type
(delegate_declaration name: (identifier) @name) @symbol.type
(method_declaration name: (identifier) @name) @symbol.method
(constructor_declaration name: (identifier) @name) @symbol.method
(property_declaration name: (identifier) @name) @symbol.method
