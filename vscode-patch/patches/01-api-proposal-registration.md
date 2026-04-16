# Patch 01: API proposal registration

## File
`src/vs/platform/extensions/common/extensionsApiProposals.ts`

## Nature
**Auto-generated.** The file header states `DO NOT EDIT DIRECTLY`. The generator script scans `src/vscode-dts/` for files matching `vscode.proposed.<name>.d.ts` and rebuilds the registry.

## Action
After dropping `src/vscode-dts/vscode.proposed.notebookEditorScroll.d.ts` into the repository, regenerate:

```bash
npm run --silent compile-api-proposal-names
```

(Or whichever task your VS Code checkout defines — in recent trees this is wired into the `prepublish` / `compile` pipeline and runs automatically on `npm run watch`.)

## Expected diff (for reference only — do not hand-edit)

A new entry will appear in the `_allApiProposals` object, lexically sorted:

```ts
notebookEditorScroll: {
    proposal: 'https://raw.githubusercontent.com/microsoft/vscode/main/src/vscode-dts/vscode.proposed.notebookEditorScroll.d.ts',
},
```

## Consumer contract
Once registered, extensions opt in via their `package.json`:

```jsonc
{
  "enabledApiProposals": ["notebookEditorScroll"]
}
```
