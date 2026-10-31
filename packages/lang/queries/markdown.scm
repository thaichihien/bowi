; Symbols for Markdown: sections, named after their heading (PARSE-2). A section runs to the
; next heading of the same or a higher level, so subsections nest inside it. The grammar opens
; sections for `#` headings only; underlined (setext) headings stay part of their section.

(section (atx_heading heading_content: (_) @name)) @symbol.section
