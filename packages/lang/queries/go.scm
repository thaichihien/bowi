; Symbols for Go (M15). Each pattern captures the defining node as @symbol.<kind> and its name
; as @name. A method is named after its receiver type (`Server.Start`), and a type is a class
; (struct), an interface or a type by what it declares (src/symbols.ts).

(function_declaration name: (identifier) @name) @symbol.function
(method_declaration name: (field_identifier) @name) @symbol.method
(type_spec name: (type_identifier) @name) @symbol.type
(type_alias name: (type_identifier) @name) @symbol.type

; Package-level constants and variables.
(source_file (const_declaration (const_spec name: (identifier) @name) @symbol.constant))
(source_file (var_declaration (var_spec name: (identifier) @name) @symbol.constant))
