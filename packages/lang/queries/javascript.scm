; Symbols for JavaScript and JSX (requirement.md SYM-1). Same captures as typescript.scm.

(function_declaration name: (_) @name) @symbol.function
(generator_function_declaration name: (_) @name) @symbol.function
(class_declaration name: (_) @name) @symbol.class
(method_definition name: (_) @name) @symbol.method
(field_definition property: (_) @name value: [(arrow_function) (function_expression)]) @symbol.method
(variable_declarator name: (identifier) @name) @symbol.variable

((call_expression
  function: (identifier) @test.fn
  arguments: (arguments . (string) @name)) @symbol.test
 (#match? @test.fn "^(describe|it|test|suite|context)$"))
((call_expression
  function: (identifier) @name
  arguments: (arguments)) @symbol.hook
 (#match? @name "^(beforeEach|afterEach|beforeAll|afterAll)$"))
