import {
  Disposable,
  ExtensionContext,
  Position,
  Range,
  Selection,
  TextDocument,
  TextDocumentWillSaveEvent,
  TextEdit,
  TextEditor,
  TextEditorEdit,
  window,
  workspace
} from "vscode";
import helper from "./documenter.helper";

const defaultTemplates = require("../templates/templates.file.js");

export default class FileDocumenter {
  private cursorPositions: { [fileURI: string]: Position } = {};
  private readonly HEADER_LENGTH_LINES: number = 13;
  private isHeaderBeingInserted: boolean = false;

  constructor(context: ExtensionContext) {
    this.setListenerOnPreSave(context);
    this.setListenerOnPostSave(context);
  }

  insertFileHeaderFromCommand(editor: TextEditor, edit: TextEditorEdit) {
    if (!this.isValidLanguageOnRequest(editor.document)) {
      window.showErrorMessage("SFDoc: Unsupported file type and/or language");
      return;
    }

    if (this.checkForHeaderOnDoc(editor.document)) {
      window.showErrorMessage(
        "SFDoc: Header already present on file's first line"
      );
      return;
    }

    edit.insert(new Position(0, 0), this.getFileHeader(editor.document));
  }

  checkForHeaderOnDoc(document: TextDocument): boolean {
    const firstLineText: string = document.lineAt(0).text;

    return (
      this.isLineABlockComment(firstLineText) ||
      this.isLineAnXMLComment(firstLineText)
    );
  }

  isValidLanguageOnRequest(document: TextDocument): boolean {
    const languageId = document.languageId;

    if (languageId === "apex") return true;
    if (languageId === "visualforce") return true;
    if (languageId === "html") return true;
    if (languageId === "javascript") return true;

    return false;
  }

  private setListenerOnPreSave(context: ExtensionContext): void {
    const preSaveHookListener: Disposable = workspace.onWillSaveTextDocument.call(
      this,
      (event: TextDocumentWillSaveEvent) => {
        if (!event.document.isDirty) return;
        if (!this.isValidLanguage(event.document)) return;

        event.waitUntil(this.insertOrUpdateHeader(event.document));
      }
    );
    context.subscriptions.push(preSaveHookListener);
  }

  private setListenerOnPostSave(context: ExtensionContext): void {
    const postSaveHookListener = workspace.onDidSaveTextDocument(
      this.replaceCursor.bind(this)
    );
    context.subscriptions.push(postSaveHookListener);
  }

  private replaceCursor(): void {
    if (!Object.keys(this.cursorPositions).length) return;
    if (!window.visibleTextEditors.length) return;

    //* Loop is fix for single file in multiple panes jumping to EOF, but VSCode's default
    //*   behavior cannot be prevented as of now. Fix will stay in place nevertheless.
    window.visibleTextEditors.forEach((editor: TextEditor) => {
      editor.selection = new Selection(
        this.getLastSavedCursorPosition(editor.document.uri.toString()),
        this.getLastSavedCursorPosition(editor.document.uri.toString())
      );
    });

    this.cursorPositions = {};
  }

  private insertOrUpdateHeader(document: TextDocument): Thenable<TextEdit[]> {
    //* Prevent capturing the Cursor position when saving from script
    if (window.activeTextEditor)
      this.cursorPositions[document.uri.toString()] =
        window.activeTextEditor.selection.active;

    this.isHeaderBeingInserted = this.checkForHeaderOnDoc(document);

    return this.isHeaderBeingInserted
      ? this.getUpdateHeaderValueEdit(document)
      : this.getInsertFileHeaderEdit(document);
  }

  private getLastSavedCursorPosition(documentURI: string): Position {
    if (!this.cursorPositions[documentURI])
      return new Position(
        this.isHeaderBeingInserted ? 0 : this.HEADER_LENGTH_LINES,
        0
      );

    return new Position(
      this.cursorPositions[documentURI].line +
        (this.isHeaderBeingInserted ? 0 : this.HEADER_LENGTH_LINES),
      this.cursorPositions[documentURI].character
    );
  }

  private async getInsertFileHeaderEdit(
    document: TextDocument
  ): Promise<TextEdit[]> {
    return [TextEdit.insert(new Position(0, 0), this.getFileHeader(document))];
  }

  private getFileHeader(document: TextDocument): string {
    return defaultTemplates[document.languageId](
      document.fileName.split(/\/|\\/g).pop(),
      helper.getConfiguredUsername(),
      helper.getHeaderFormattedDateTime()
    );
  }

  private isLineABlockComment(lineContent: string): boolean {
    const re = /^\s*\/\*/g;
    return re.test(lineContent);
  }

  private isLineAnXMLComment(lineContent: string): boolean {
    const re = /^\s*<!--/g;
    return re.test(lineContent);
  }

  private isValidLanguage(document: TextDocument): boolean {
    const lang = document.languageId;
    const configs = workspace.getConfiguration("SFDoc");
    const enabledForApex = configs.get("EnableForApex");
    const enabledForVf = configs.get("EnableForVisualforce");
    const enabledForLightMarkup = configs.get("EnableForLightningMarkup", true);
    const enabledForLightningJavaScript = configs.get(
      "EnableForLightningJavascript",
      false
    );

    if (lang === "apex" && enabledForApex) return true;

    if (lang === "visualforce" && enabledForVf) return true;

    if (lang === "html")
      return enabledForLightMarkup && this.isLightning(document);

    if (lang === "javascript")
      return enabledForLightningJavaScript && this.isLightning(document);

    return false;
  }

  private isLightning(document: TextDocument): boolean {
    const validExtensions: string[] = ["htm", "html", "cmp", "js"];
    const validSalesforceFolderNames = ["aura", "lwc"];
    const pathTokens = document.uri.path.split("/");
    const folderName = pathTokens[pathTokens.length - 2];
    const parentFolderName =
      pathTokens.length >= 3 ? pathTokens[pathTokens.length - 3] : null;
    const [fileName, fileExtension] = pathTokens[pathTokens.length - 1].split(
      "."
    );
    const lightningJavaScriptFileRegex = /Controller|Helper/gi;
    const folderNameMatchRegex = new RegExp(`^${folderName}$`);
    const processedFileName =
      document.languageId === "javascript"
        ? fileName.replace(lightningJavaScriptFileRegex, "")
        : fileName;

    if (!folderNameMatchRegex.test(processedFileName)) return false;
    if (!validExtensions.includes(fileExtension)) return false;
    if (!parentFolderName) return false;
    if (!validSalesforceFolderNames.includes(parentFolderName)) return false;

    return true;
  }

  private async getUpdateHeaderValueEdit(
    document: TextDocument
  ): Promise<TextEdit[]> {
    return [
      TextEdit.replace(
        this.getFullDocumentRange(document),
        this.updateHeaderLastModifiedByAndDate(document.getText())
      )
    ];
  }

  private updateHeaderLastModifiedByAndDate(documentText: string): string {
    return this.updateLastModifiedDateTime(
      this.updateLastModifiedBy(documentText)
    );
  }

  private updateLastModifiedBy(fileContent: string): string {
    const re = /^(\s*[\*\s]*@Last\s*Modified\s*By\s*:).*/gm;
    return fileContent.replace(re, `$1 ${helper.getConfiguredUsername()}`);
  }

  private updateLastModifiedDateTime(fileContent: string): string {
    const re = /^(\s*[\*\s]*@Last\s*Modified\s*On\s*:).*/gm;
    return fileContent.replace(re, `$1 ${helper.getHeaderFormattedDateTime()}`);
  }

  private getFullDocumentRange(document: TextDocument): Range {
    const lastChar = document.lineAt(document.lineCount - 1).text.length;

    return new Range(
      new Position(0, 0),
      new Position(document.lineCount, lastChar)
    );
  }
}