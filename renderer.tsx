import { Renderer } from "@k8slens/extensions";
import { NodeMenu } from "./src/node-menu";
import { PodAttachMenu } from "./src/attach-menu";
import { PodShellMenu } from "./src/shell-menu";
import { PodLogsMenu } from "./src/logs-menu";
import { ServiceLogsPage } from "./src/renderer/service-logs-page";
import { navigateToServiceLogs, registerServiceLogsIpc } from "./src/renderer/ipc";
import { SERVICE_LOGS_PAGE_ID } from "./src/common/types";
import React from "react";

const { Component: { Icon } } = Renderer;

const serviceLogsPage = {
  id: SERVICE_LOGS_PAGE_ID,
  components: {
    Page: () => <ServiceLogsPage />,
  },
};

export default class PodMenuRendererExtension extends Renderer.LensExtension {
  globalPages = [serviceLogsPage];

  clusterPages = [serviceLogsPage];

  clusterPageMenus = [
    {
      target: { pageId: SERVICE_LOGS_PAGE_ID },
      title: "Service logs",
      components: {
        Icon: (props: Renderer.Component.IconProps) => <Icon {...props} material="cloud_download"/>,
      },
    },
  ];

  commands = [
    {
      id: "openlens-node-pod-menu.service-logs",
      title: "Service logs: скачать логи всего сервиса",
      action: (): void => {
        void navigateToServiceLogs();
      },
    },
  ];

  kubeObjectMenuItems = [
    {
      kind: "Node",
      apiVersions: ["v1"],
      components: {
        MenuItem: (props: Renderer.Component.KubeObjectMenuProps<Renderer.K8sApi.Node>) => <NodeMenu {...props} />,
      },
    },
    {
      kind: "Pod",
      apiVersions: ["v1"],
      components: {
        MenuItem: (props: Renderer.Component.KubeObjectMenuProps<Renderer.K8sApi.Pod>) => <PodAttachMenu {...props} />,
      },
    },
    {
      kind: "Pod",
      apiVersions: ["v1"],
      components: {
        MenuItem: (props: Renderer.Component.KubeObjectMenuProps<Renderer.K8sApi.Pod>) => <PodShellMenu {...props} />,
      },
    },
    {
      kind: "Pod",
      apiVersions: ["v1"],
      components: {
        MenuItem: (props: Renderer.Component.KubeObjectMenuProps<Renderer.K8sApi.Pod>) => <PodLogsMenu {...props} />,
      },
    },
  ];

  async onActivate(): Promise<void> {
    registerServiceLogsIpc(this);
  }
}
