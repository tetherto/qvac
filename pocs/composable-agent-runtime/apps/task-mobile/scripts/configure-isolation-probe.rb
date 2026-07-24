#!/usr/bin/env ruby

require 'xcodeproj'

project_path = File.expand_path(
  '../ios/ComposableRuntimeFeasibility.xcodeproj',
  __dir__
)
project = Xcodeproj::Project.open(project_path)
host = project.targets.find { |target| target.name == 'ComposableRuntimeFeasibility' }
abort 'ComposableRuntimeFeasibility target not found' unless host

extension = project.targets.find { |target| target.name == 'IsolationProbeExtension' }
extension ||= project.new_target(
  :app_extension,
  'IsolationProbeExtension',
  :ios,
  '26.0'
)

extension.build_configurations.each do |configuration|
  settings = configuration.build_settings
  settings['APPLICATION_EXTENSION_API_ONLY'] = 'YES'
  settings['CODE_SIGN_ENTITLEMENTS'] =
    'IsolationProbeExtension/IsolationProbeExtension.entitlements'
  settings['CODE_SIGN_IDENTITY'] = 'Apple Development'
  settings['CODE_SIGN_STYLE'] = 'Automatic'
  settings['CURRENT_PROJECT_VERSION'] = '1'
  settings['DEVELOPMENT_TEAM'] = 'N4778P74XX'
  settings['ENABLE_ENHANCED_SECURITY'] = 'YES'
  settings['GENERATE_INFOPLIST_FILE'] = 'YES'
  settings.delete('INFOPLIST_FILE')
  settings['IPHONEOS_DEPLOYMENT_TARGET'] = '26.0'
  settings['MARKETING_VERSION'] = '1.0'
  settings['PRODUCT_BUNDLE_IDENTIFIER'] =
    'com.qvac.poc.composable-runtime.isolation-probe'
  settings['PRODUCT_NAME'] = '$(TARGET_NAME)'
  settings['SDKROOT'] = 'iphoneos'
  settings['SKIP_INSTALL'] = 'YES'
  settings['SWIFT_VERSION'] = '5.0'
  settings['TARGETED_DEVICE_FAMILY'] = '1'
end

foundation = extension.frameworks_build_phase.files_references.find do |reference|
  reference.name == 'Foundation.framework'
end
if foundation
  foundation.path = 'System/Library/Frameworks/Foundation.framework'
  foundation.source_tree = 'SDKROOT'
end

host.build_configurations.each do |configuration|
  configuration.build_settings['EX_ENABLE_EXTENSION_POINT_GENERATION'] = 'YES'
end

project.root_object.attributes['TargetAttributes'] ||= {}
project.root_object.attributes['TargetAttributes'][extension.uuid] = {
  'DevelopmentTeam' => 'N4778P74XX',
  'ProvisioningStyle' => 'Automatic'
}

def file_reference(group, path)
  group.files.find { |file| file.path == path } || group.new_file(path)
end

def add_source(target, reference)
  return if target.source_build_phase.files_references.include?(reference)

  target.source_build_phase.add_file_reference(reference)
end

main_group = project.main_group
host_group = main_group.groups.find do |group|
  group.name == 'ComposableRuntimeFeasibility'
end
abort 'ComposableRuntimeFeasibility source group not found' unless host_group

shared_group =
  main_group.groups.find { |group| group.name == 'IsolationProbeShared' } ||
  main_group.new_group('IsolationProbeShared')
shared_reference = file_reference(shared_group, 'IsolationProbeShared.swift')
host_reference = file_reference(
  host_group,
  'ComposableRuntimeFeasibility/IsolationProbeHost.swift'
)

extension_group =
  main_group.groups.find { |group| group.name == 'IsolationProbeExtension' } ||
  main_group.new_group('IsolationProbeExtension', 'IsolationProbeExtension')
extension_reference = file_reference(
  extension_group,
  'IsolationProbeExtension.swift'
)
file_reference(extension_group, 'IsolationProbeExtension.entitlements')

add_source(host, shared_reference)
add_source(host, host_reference)
add_source(extension, shared_reference)
add_source(extension, extension_reference)

host.add_dependency(extension) unless host.dependencies.any? do |dependency|
  dependency.target == extension
end

embed_phase = host.copy_files_build_phases.find do |phase|
  phase.name == 'Embed App Extensions'
end
embed_phase ||= host.new_copy_files_build_phase('Embed App Extensions')
embed_phase.dst_subfolder_spec = '13'

unless embed_phase.files_references.include?(extension.product_reference)
  build_file = embed_phase.add_file_reference(extension.product_reference, true)
  build_file.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }
end

project.save
