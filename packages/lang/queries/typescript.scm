; Symbols for TypeScript and TSX (requirement.md SYM-1).
; Each pattern captures the defining node as @symbol.<kind> and its name as @name.
; Scoping rules (e.g. variables only at top level) are applied in src/symbols.ts.

(function_declaration name: (_) @name) @symbol.function
(generator_function_declaration name: (_) @name) @symbol.function
(function_signature name: (_) @name) @symbol.function
(class_declaration name: (_) @name) @symbol.class
(abstract_class_declaration name: (_) @name) @symbol.class
(method_definition name: (_) @name) @symbol.method
(method_signature name: (_) @name) @symbol.method
(abstract_method_signature name: (_) @name) @symbol.method
(public_field_definition name: (_) @name value: [(arrow_function) (function_expression)]) @symbol.method
(interface_declaration name: (_) @name) @symbol.interface
(type_alias_declaration name: (_) @name) @symbol.type
(enum_declaration name: (_) @name) @symbol.type
(variable_declarator name: (identifier) @name) @symbol.variable

; Test blocks: describe('x', ...), it('y', ...), and hooks.
((call_expression
  function: (identifier) @test.fn
  arguments: (arguments . (string) @name)) @symbol.test
 (#match? @test.fn "^(describe|it|test|suite|context)$"))
((call_expression
  function: (identifier) @name
  arguments: (arguments)) @symbol.hook
 (#match? @name "^(beforeEach|afterEach|beforeAll|afterAll)$"))
