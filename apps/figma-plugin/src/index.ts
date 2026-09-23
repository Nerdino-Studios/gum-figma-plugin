import { readSelection } from './document/selection';

figma.showUI(__html__, { width: 420, height: 560, themeColors: true });
figma.ui.postMessage(readSelection());
figma.on('selectionchange', () => figma.ui.postMessage(readSelection()));
