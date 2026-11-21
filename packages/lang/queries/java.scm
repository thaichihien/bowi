; Symbols for Java (M16). Each pattern captures the defining node as @symbol.<kind> and its name
; as @name. Fields belong to their class, as in TypeScript. An overloaded method or constructor
; has its parameter types in its qualified name (src/symbols.ts).

(class_declaration name: (identifier) @name) @symbol.class
(record_declaration name: (identifier) @name) @symbol.class
(enum_declaration name: (identifier) @name) @symbol.class
(interface_declaration name: (identifier) @name) @symbol.interface
(annotation_type_declaration name: (identifier) @name) @symbol.interface
(method_declaration name: (identifier) @name) @symbol.method
(constructor_declaration name: (identifier) @name) @symbol.method
(compact_constructor_declaration name: (identifier) @name) @symbol.method
(annotation_type_element_declaration name: (identifier) @name) @symbol.method
