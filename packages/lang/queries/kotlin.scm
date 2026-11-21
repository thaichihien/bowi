; Symbols for Kotlin (M16). Each pattern captures the defining node as @symbol.<kind> and its
; name as @name. `interface` is a class declaration with that keyword, a function directly in a
; class is a method, and a companion object's members belong to the class (src/symbols.ts).
; Class properties belong to their class, as fields do in TypeScript.

(class_declaration name: (identifier) @name) @symbol.class
(object_declaration name: (identifier) @name) @symbol.class
(function_declaration name: (identifier) @name) @symbol.function
(secondary_constructor "constructor" @name) @symbol.method
(type_alias type: (identifier) @name) @symbol.type

; Top-level properties.
(source_file (property_declaration (variable_declaration (identifier) @name)) @symbol.constant)
