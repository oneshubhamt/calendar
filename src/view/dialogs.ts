function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, value: string, className = "dc-btn"): HTMLButtonElement {
  const node = element("button", className, label);
  node.type = "button";
  node.value = value;
  return node;
}

function field(label: string, control: HTMLElement): HTMLElement {
  const wrapper = element("label", "dc-field");
  wrapper.append(element("span", "dc-field-label", label), control);
  return wrapper;
}

function mountDialog(host: HTMLElement, dialog: HTMLDialogElement): void {
  host.append(dialog);
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  dialog.showModal();
}

export async function requestCalendarDate(
  host: HTMLElement,
  title: string,
  initialDate: string,
  confirmLabel: string,
): Promise<string | null> {
  const dialog = element("dialog", "dc-dialog dc-scope-dialog");
  dialog.setAttribute("aria-label", title);
  const form = element("form", "dc-editor");
  form.method = "dialog";
  const header = element("div", "dc-dialog-header");
  header.append(element("h2", undefined, title));
  const body = element("div", "dc-dialog-body");
  const input = element("input", "dc-input");
  input.type = "date";
  input.required = true;
  input.value = initialDate;
  body.append(field("Date", input));
  const footer = element("div", "dc-dialog-footer");
  const cancel = button("Cancel", "cancel");
  const confirm = button(confirmLabel, "confirm", "dc-btn dc-primary");
  cancel.addEventListener("click", () => dialog.close("cancel"));
  confirm.addEventListener("click", () => {
    if (!input.reportValidity()) return;
    dialog.close("confirm");
  });
  footer.append(cancel, confirm);
  form.append(header, body, footer);
  dialog.append(form);
  mountDialog(host, dialog);
  input.focus();
  return await new Promise(resolve => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm" ? input.value : null), { once: true });
  });
}

export async function confirmCalendarAction(
  host: HTMLElement,
  title: string,
  message: string,
  confirmLabel: string,
  danger = false,
): Promise<boolean> {
  const dialog = element("dialog", "dc-dialog dc-scope-dialog");
  dialog.setAttribute("aria-label", title);
  const box = element("div", "dc-scope-box");
  box.append(element("h2", undefined, title), element("p", "dc-muted", message));
  const actions = element("div", "dc-dialog-footer");
  const cancel = button("Cancel", "cancel");
  const confirm = button(confirmLabel, "confirm", `dc-btn${danger ? " dc-danger" : " dc-primary"}`);
  cancel.addEventListener("click", () => dialog.close("cancel"));
  confirm.addEventListener("click", () => dialog.close("confirm"));
  actions.append(cancel, confirm);
  box.append(actions);
  dialog.append(box);
  mountDialog(host, dialog);
  cancel.focus();
  return await new Promise(resolve => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
  });
}
