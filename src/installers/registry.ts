import type { Installer } from "./types.js";
import { gitInstaller } from "./git.js";
import { nodeInstaller } from "./node.js";
import { cmakeInstaller } from "./cmake.js";
import { javaInstaller } from "./java.js";
import { vscodeInstaller } from "./vscode.js";
import { ollamaInstaller } from "./ollama.js";
import { vulkanInstaller } from "./vulkan.js";
import { blenderInstaller } from "./blender.js";
import { androidInstaller } from "./android.js";

export const INSTALLERS: Record<string, Installer> = {
  git: gitInstaller,
  node: nodeInstaller,
  cmake: cmakeInstaller,
  java: javaInstaller,
  vscode: vscodeInstaller,
  ollama: ollamaInstaller,
  vulkan: vulkanInstaller,
  blender: blenderInstaller,
  android: androidInstaller,
};
