"""Desktop-scoped native auxiliary callbacks, with loopback-only inference."""
import asyncio
import sys

from tests.test_subagent_native_startup import isolated  # noqa: F401
from tests.test_agent_model_runtime import local_models  # noqa: F401


async def test_prepared_desktop_root_omits_optional_lcm_but_native_sdk_compaction_uses_selected_model(local_models, monkeypatch):  # noqa: F811
    import json
    from misaka.config import home
    from misaka.cli import bootstrap
    from misaka.core.wiring import role_session_setup
    from misaka.config.product import current_config
    from misaka.desktop_research.runtime import DesktopExecutionScope, prepare_desktop_assembly
    from misaka.desktop_research.team import DesktopResearchTeam
    from misaka.extensions.misaka_lcm.host import acp
    root,requests=local_models
    fixture_settings=json.loads(home.path('settings').read_text())
    fixture_settings['compaction']={'keepRecentTokens':1,'reserveTokens':1024,'enabled':False}
    home.path('settings').write_text(json.dumps(fixture_settings))
    bootstrap.install()
    flags,assembly,_env=role_session_setup(str(root/'profiles/last_order'),str(root/'workspace'),
        research_context=True,research_host=True)
    normal_factories=list(assembly.extension_factories)
    assert any(item['name']=='misaka_lcm' for item in normal_factories)
    external=[]
    async def forbidden(**kwargs):
        external.append(kwargs)
        raise AssertionError('Alternate external model route was attempted')
    monkeypatch.setattr(acp,'complete',forbidden)
    prepare_desktop_assembly(assembly)
    assert not any(item['name']=='misaka_lcm' for item in assembly.extension_factories)
    _,normal,_=role_session_setup(str(root/'profiles/last_order'),str(root/'workspace'))
    assert any(item['name']=='misaka_lcm' for item in normal.extension_factories)
    team=DesktopResearchTeam(root/'team-session',root/'profiles/sisters','fixture-lo','shared')
    scope=DesktopExecutionScope(team,current_config())
    runtime,session,error=await scope.open_session([*flags,'--session-dir',str(root/'sessions/compact')],str(root/'workspace'),assembly)
    try:
        assert error is None,error
        callbacks=[handler for ext in session.extensionRunner.extensions for group in ext.handlers.values() for handler in group]
        assert not any(getattr(handler,'__module__','').startswith('misaka.extensions.misaka_lcm') for handler in callbacks)
        await session.prompt('SDK_COMPACTION_MARKER with native team binding')
        await session.prompt('The second evidence fixture turn, retaining uncertainties')
        await session.compact('Keep the research question and uncertainties')
        assert len(requests)>=2
        assert all((p,data['model'])==('fixture-lo','shared') for p,data in requests)
        assert not external
    finally:
        await scope.native.module('misaka.core.platform.session').dispose(runtime)


def test_private_relative_imports_resolve_without_modifying_package_modules():
    from misaka.desktop_research.native_scope import NativeScope
    from misaka.extensions.misaka_lcm.host import native,llm
    sentinel=lambda **kwargs:'desktop'
    scope=NativeScope({'misaka.extensions.misaka_lcm.host.llm':{'call_llm':sentinel}},
        modules={'misaka.extensions.misaka_lcm.host.native'})
    assert scope.module('misaka.extensions.misaka_lcm.host.native').call_llm()=='desktop'
    assert native.llm is llm

async def test_browser_screenshot_reports_selected_model_capability_without_alternate_vision(tmp_path,monkeypatch):
    from types import SimpleNamespace
    from misaka.config.product import current_config
    from misaka.desktop_research.runtime import DesktopExecutionScope
    from misaka.desktop_research.team import DesktopResearchTeam
    from misaka.core.web.browser import tools,settings
    import importlib
    stream=importlib.import_module('misaka.ai.stream')
    team=DesktopResearchTeam(tmp_path/'session',tmp_path/'shared','fixture','text-only')
    scope=DesktopExecutionScope(team,current_config())
    calls=[]
    async def forbidden(*args,**kwargs):
        calls.append(args)
        raise AssertionError('Alternate image inference attempted')
    monkeypatch.setattr(stream,'complete_simple',forbidden)
    monkeypatch.setattr(settings,'config',lambda:{'vision_model':'external/vision'})
    from PIL import Image
    from io import BytesIO
    image=BytesIO()
    Image.new('RGB',(1,1),'white').save(image,format='PNG')
    body=image.getvalue()
    ctx=SimpleNamespace(model=SimpleNamespace(input=['text']),modelRegistry=SimpleNamespace(
       find=lambda p,m:SimpleNamespace(provider=p,id=m,input=['text'])))
    result=await scope.native.module('misaka.core.web.browser.tools').image_content(body,'Read screenshot',ctx)
    assert 'no image capability' in result[0]['text']
    assert not calls
    assert tools.image_content.__module__=='misaka.core.web.browser.tools'
