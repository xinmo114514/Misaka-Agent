"""Optional auxiliary policy for independent desktop research only.

LCM's alternative/external transports and operation lock lifetime cannot safely
participate in the frozen native model-switch protocol. Research uses the native
SDK compactor instead; normal desktop/TUI LCM factories and source are untouched.
"""
from __future__ import annotations

AUXILIARY_DIAGNOSTIC = {
    'code': 'desktop_native_compaction',
    'message': 'This independent research root uses native SDK compaction on its selected team model. '
               'Optional external auxiliary model routes are omitted for this root and its workers; '
               'ordinary desktop/TUI settings and factories are unchanged.'}


def prepare_desktop_assembly(assembly):
    """Apply a factory's declared strict-model variant, without knowing its package."""
    prepared = []
    for item in assembly.extension_factories:
        replacement = getattr(item.get('factory'), 'desktop_research_factory', None)
        if callable(replacement):
            prepared.append({**item, 'factory': replacement, 'hidden': True,
                             'name': getattr(replacement, 'extension_name', item['name'])})
        else:
            prepared.append(item)
    assembly._extension_factories = prepared
    assembly._desktop_runtime_diagnostics = [dict(AUXILIARY_DIAGNOSTIC)]
    return assembly


def install_auxiliary_factories(owner, overrides, modules, classes):
    async def image_content(body, _question, context):
        from misaka.core.web.browser.tools import processImage as process_image
        from misaka.utils.values import read_field

        from .runtime import wait_model_ready
        binding = await wait_model_ready(owner.policy, read_field(context, 'signal'), role=owner.role)
        registry = read_field(context, 'modelRegistry')
        selected = registry.find(binding['provider'], binding['modelId']) if registry else None
        processed = await process_image(body, 'image/png')
        if not processed.ok:
            raise ValueError(processed.message)
        if selected is not None and 'image' in selected.input:
            return [{'type': 'image', 'data': processed.data, 'mimeType': processed.mimeType}]
        return [{'type': 'text', 'text': 'Screenshot saved. The selected team model has no image capability; '
                 'use the accessibility snapshot or saved artifact. No alternate vision model was called.'}]
    overrides['misaka.core.web.browser.tools'] = {'image_content': image_content}
    modules.update({'misaka.core.web', 'misaka.core.web.browser.tools'})
    classes.add(('misaka.core.web', 'WebPart'))


def adapt_extension_factories(_owner, assembly):
    return prepare_desktop_assembly(assembly)


def omit_live_auxiliaries(session):
    """Fallback for an idle host whose callbacks declare a strict-model variant."""
    runner = getattr(session, '_extensionRunner', None)
    if runner is None:
        return
    def external_auxiliary(extension):
        callbacks = [callback for group in extension.handlers.values() for callback in group]
        return any(callable(getattr(callback, 'desktop_research_factory', None)) for callback in callbacks)
    omitted = [extension for extension in runner.extensions if external_auxiliary(extension)]
    if not omitted:
        return
    runner.extensions[:] = [extension for extension in runner.extensions if not external_auxiliary(extension)]
    loaded = session._resourceLoader.getExtensions().extensions
    loaded[:] = [extension for extension in loaded if not external_auxiliary(extension)]
    session.refreshTools()


def adapt_live_extensions(_owner, session):
    omit_live_auxiliaries(session)
