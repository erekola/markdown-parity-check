# Comparing Starlight content

The Starlight profile compares the content of every associated tab panel, including panels hidden on initial page load. It also preserves Expressive Code line boundaries and reads Starlight aside titles. Generic HTML extraction remains the default.

Choose `--html-profile starlight` in the CLI or pass `htmlProfile: 'starlight'` to the library. The HTML extraction strategy and notes record the selected profile in the report.

Use the article body as the HTML content region. A complete document export can include page descriptions that appear only in HTML metadata, so check that metadata separately before comparing article bodies. A shortened Markdown export is a different input and may intentionally omit notes or expandable sections.

Inactive panel content is included only when the tab and panel identifiers form a complete, unambiguous association. Hidden descendants remain hidden. Missing associations stop the comparison with an input error. Terminal frame labels are omitted, while code filenames remain part of the comparison.

This profile does not execute JavaScript or test browser interactions. It supports the component structures covered by the tests. A passing result means the extracted blocks contain no rejecting differences.
