import { useRef, useState, useEffect } from "react";
import { Worklet } from "react-native-bare-kit";
import { Asset } from "expo-asset";
import RPC from "bare-rpc";

const DEFAULT_CALLBACK = () => {
  // noop
};

const useWorklet = ({ callback = DEFAULT_CALLBACK }) => {
  const worklet = new Worklet();

  const rpcRef = useRef(null);

  const [rpcReady, setRPCReady] = useState(false);

  useEffect(() => {
    const bareBundle = require("../../backend/app.bundle");

    Asset.loadAsync([bareBundle]).then(async ([asset]) => {
      const response = await fetch(asset.localUri);
      const bundleSource = await response.text();
      worklet.start('/app.bundle', bundleSource);
      if (!rpcRef.current) {
        rpcRef.current = new RPC(worklet.IPC, callback);
        setRPCReady(true);
      }
    });
  }, []);

  return [rpcRef.current, rpcReady];
};

export default useWorklet;