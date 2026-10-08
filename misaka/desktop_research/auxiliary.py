"""Optional auxiliary policy for independent desktop research only.

LCM's alternative/external transports and operation lock lifetime cannot safely
participate in the frozen native model-switch protocol. Research uses the native
SDK compactor instead; normal desktop/TUI LCM factories and source are untouched.
"""
from __future__ import annotations

LCM_PREFIX = 'misaka.extensions.misaka_lcm'
LCM_DIAGNOSTIC = {
    'code': 'desktop_native_compaction',
    'message': 'This independent research root uses native SDK compaction on its selected team model. '
               'Optional LCM model-backed/external auxiliary routes are omitted for this root and its workers; '
               'ordinary desktop/TUI LCM settings and factories are unchanged.'}


def is_lcm_factory(item):
    return item.get('name') == 'misaka_lcm' or getattr(item.get('factory'), '__module__', '').startswith(LCM_PREFIX)


def register_native_auth(harn):
    # The optional extension also publishes a native OAuth implementation.
    # Preserve that native registry/auth source, without its LCM callbacks/tools.
    from misaka.extensions.misaka_lcm.host.nous import flow
    harn.registerProvider('nous', {'oauth': flow})


def prepare_desktop_assembly(assembly):
    """Call BEFORE open_session; only this caller-owned assembly is changed."""
    factories = list(assembly.extension_factories)
    if any(is_lcm_factory(item) for item in factories):
        assembly._extension_factories = [item for item in factories if not is_lcm_factory(item)] + [
            {'name': 'desktop-native-auth', 'factory': register_native_auth, 'hidden': True}]
    assembly._desktop_runtime_diagnostics = [dict(LCM_DIAGNOSTIC)]
    return assembly


def install_auxiliary_factories(owner, overrides, modules, classes):
    async def image_content(body, _question, context):
        from misaka.core.web.browser.tools import process_image
        from misaka.utils.values import read_field

        from .runtime import wait_model_ready
        binding = await wait_model_ready(owner.policy, read_field(context, 'signal'))
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


def omit_live_lcm(session):
    """Fallback for a caller that constructed an idle host before preparing it."""
    runner = getattr(session, '_extensionRunner', None)
    if runner is None:
        return
    def is_lcm(extension):
        callbacks = [callback for group in extension.handlers.values() for callback in group]
        return any(getattr(callback, '__module__', '').startswith(LCM_PREFIX) for callback in callbacks)
    omitted = [extension for extension in runner.extensions if is_lcm(extension)]
    if not omitted:
        return
    runner.extensions[:] = [extension for extension in runner.extensions if not is_lcm(extension)]
    loaded = session._resourceLoader.getExtensions().extensions
    loaded[:] = [extension for extension in loaded if not is_lcm(extension)]
    session.refreshTools()


def adapt_live_extensions(_owner, session):
    omit_live_lcm(session)
