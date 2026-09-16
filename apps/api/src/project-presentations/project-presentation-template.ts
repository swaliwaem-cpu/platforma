import type * as ProjectPresentationTemplate from '@platforma/shared/project-presentation-template' with { 'resolution-mode': 'import' };

export type ProjectPresentationTemplateModule = typeof ProjectPresentationTemplate;

let templateModule: Promise<ProjectPresentationTemplateModule> | null = null;

// The shared template is an ES module and the API is CommonJS, so it is loaded with a dynamic import.
export function loadProjectPresentationTemplate() {
  templateModule ??= import('@platforma/shared/project-presentation-template');
  return templateModule;
}

export function resolveProjectPresentationFontPath(file: string) {
  return require.resolve(`@platforma/shared/project-presentation-fonts/${file}`);
}
