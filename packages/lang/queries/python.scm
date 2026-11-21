; Symbols for Python (M15). Each pattern captures the defining node as @symbol.<kind> and its
; name as @name. A function directly inside a class is a method, and a decorated definition's
; lines include its decorators (src/symbols.ts).

(class_definition name: (identifier) @name) @symbol.class
(function_definition name: (identifier) @name) @symbol.function

; Module-level names: constants, settings, type aliases (`Handler = Callable[...]`).
(module (expression_statement (assignment left: (identifier) @name)) @symbol.constant)
