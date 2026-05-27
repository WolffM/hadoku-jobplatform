/**
 * Stylelint config — catches `var(--name)` references to custom properties
 * that aren't defined anywhere. @wolffm/themes is the source of truth.
 */
module.exports = {
  plugins: ['stylelint-value-no-unknown-custom-properties'],
  rules: {
    'csstools/value-no-unknown-custom-properties': [
      true,
      {
        importFrom: [require.resolve('@wolffm/themes/style.css')],
      },
    ],
  },
}
